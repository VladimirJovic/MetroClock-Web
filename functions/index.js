const { onDocumentUpdated, onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();
const WORKSPACE_ID = "workspace1";

async function getConfig() {
  const snap = await db.collection("workspaces").doc(WORKSPACE_ID).get();
  const data = snap.data() || {};
  return {
    slack: data.slackWebhookUrl || null,
    discord: data.discordWebhookUrl || null,
    slackMappings: data.slackUserMappings || {},
    discordMappings: data.discordUserMappings || {},
  };
}

async function sendSlack(url, text) {
  try { await axios.post(url, { text }); } catch (e) { console.error("Slack error:", e.message); }
}

async function sendDiscord(url, content) {
  try { await axios.post(url, { content }); } catch (e) { console.error("Discord error:", e.message); }
}

async function notify(message, mentionUserId) {
  const config = await getConfig();
  const promises = [];

  if (config.slack) {
    const slackId = mentionUserId ? config.slackMappings[mentionUserId] : null;
    const slackMsg = slackId ? `<@${slackId}> ${message}` : message;
    promises.push(sendSlack(config.slack, slackMsg));
  }
  if (config.discord) {
    const discordId = mentionUserId ? config.discordMappings[mentionUserId] : null;
    const discordMsg = discordId ? `<@${discordId}> ${message}` : message;
    promises.push(sendDiscord(config.discord, discordMsg));
  }
  await Promise.all(promises);
}

async function getUserName(userId) {
  const snap = await db.collection("users").doc(userId).get();
  const d = snap.data();
  if (!d) return "Unknown";
  return `${d.firstName} ${d.lastName}`;
}

// Trigger 1: status changed -> notify employee
exports.onRequestStatusChanged = onDocumentUpdated("requests/{requestId}", async (event) => {
  const before = event.data.before.data();
  const after  = event.data.after.data();
  if (before.status === after.status) return;
  if (after.status === "pending") return;
  const employeeName = await getUserName(after.userId);
  const managerName  = await getUserName(after.managerId);
  const typeLabels = { remoteWork: "Remote Work", sickLeave: "Sick Leave", dayOff: "Day Off", overtime: "Overtime" };
  const typeLabel = typeLabels[after.type] || after.type;
  const statusEmoji = after.status === "approved" ? "✅" : "❌";
  const statusLabel = after.status === "approved" ? "approved" : "rejected";
  const date = after.date?.toDate?.()?.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) || "";
  let message = `*${employeeName}* — your *${typeLabel}* request for *${date}* has been *${statusLabel}* by ${managerName}.`;
  if (after.managerNote) message += `\n> "${after.managerNote}"`;
  await notify(`${statusEmoji} ${message}`, after.userId);
});

// Trigger 2: overtime created -> notify manager
exports.onOvertimeRequestCreated = onDocumentCreated("requests/{requestId}", async (event) => {
  const data = event.data.data();
  if (data.type !== "overtime") return;
  const employeeName = await getUserName(data.userId);
  const date = data.date?.toDate?.()?.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) || "";
  const hours = data.overtimeHours ? ` (${parseFloat(data.overtimeHours).toFixed(1)}h)` : "";
  let message = `*${employeeName}* submitted an *Overtime* request for *${date}*${hours}.`;
  if (data.employeeNote) message += `\n> "${data.employeeNote}"`;
  await notify(`⏰ ${message}`, data.managerId);
});

// Trigger 3: any request created -> notify manager
exports.onRequestCreated = onDocumentCreated("requests/{requestId}", async (event) => {
  const data = event.data.data();
  if (data.type === "overtime") return;
  const employeeName = await getUserName(data.userId);
  const date = data.date?.toDate?.()?.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) || "";
  const typeLabels = { remoteWork: "Remote Work", sickLeave: "Sick Leave", dayOff: "Day Off" };
  const typeLabel = typeLabels[data.type] || data.type;
  const hours = data.remoteHours ? ` · ${data.remoteHours}h` : "";
  let message = `*${employeeName}* submitted a *${typeLabel}${hours}* request for *${date}*.`;
  if (data.employeeNote) message += `\n> "${data.employeeNote}"`;
  await notify(`📋 ${message}`, data.managerId);
});