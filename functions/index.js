const { setGlobalOptions } = require("firebase-functions");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const https = require("https");

setGlobalOptions({ maxInstances: 10 });

// Lazy init — prevents blocking during Firebase CLI deployment analysis
let initialized = false;
let db, messaging;

function init() {
  if (initialized) return;
  admin.initializeApp();
  db = admin.firestore();
  messaging = admin.messaging();
  initialized = true;
}

// Helper: get FCM token for a user
async function getToken(userId) {
  if (!userId) return null;
  const doc = await db.collection("users").doc(userId).get();
  if (!doc.exists) return null;
  return doc.data().fcmToken || null;
}

// Helper: send FCM notification
async function sendNotification(token, title, body) {
  if (!token) return;
  try {
    await messaging.send({
      token,
      notification: { title, body },
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default", badge: 1 } } },
    });
  } catch (err) {
    console.error("FCM send error:", err.message);
  }
}

// Helper: get workspace config (Discord/Slack webhook + user mappings)
async function getWorkspaceConfig(workspaceId) {
  if (!workspaceId) return null;
  const doc = await db.collection("workspaces").doc(workspaceId).get();
  if (!doc.exists) return null;
  return doc.data();
}

// Helper: send Discord webhook message
function sendDiscord(webhookUrl, content) {
  if (!webhookUrl || !content) return Promise.resolve();
  return new Promise((resolve) => {
    const body = JSON.stringify({ content, username: "MetroClock" });
    const url = new URL(webhookUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      console.log("[Discord] status:", res.statusCode);
      resolve();
    });
    req.on("error", (err) => { console.error("[Discord] error:", err.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// Helper: send Slack webhook message
function sendSlack(webhookUrl, text) {
  if (!webhookUrl || !text) return Promise.resolve();
  return new Promise((resolve) => {
    const body = JSON.stringify({ text });
    const url = new URL(webhookUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      console.log("[Slack] status:", res.statusCode);
      resolve();
    });
    req.on("error", (err) => { console.error("[Slack] error:", err.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// Request type display name
function requestTypeName(type) {
  const names = {
    dayOff: "Day Off",
    sickLeave: "Sick Leave",
    overtime: "Overtime",
    remoteWork: "Remote Work",
  };
  return names[type] || type;
}

// TRIGGER 1: New request submitted → notify manager
exports.onRequestCreated = onDocumentCreated("requests/{requestId}", async (event) => {
  init();
  const data = event.data.data();
  const { userId, managerId, type, workspaceId, firstName, lastName } = data;

  console.log("[onRequestCreated] fired. userId:", userId, "managerId:", managerId, "type:", type);

  if (!managerId) {
    console.log("[onRequestCreated] no managerId, skipping.");
    return;
  }

  const typeName = requestTypeName(type);
  const employeeName = `${firstName || ""} ${lastName || ""}`.trim() || "An employee";

  // FCM
  const token = await getToken(managerId);
  console.log("[onRequestCreated] manager fcmToken:", token ? "found" : "MISSING");
  await sendNotification(token, "New Request", `${employeeName} submitted a ${typeName} request`);

  // Discord + Slack
  const workspace = await getWorkspaceConfig(workspaceId);
  if (workspace) {
    const managerDiscordId = (workspace.discordUserMappings || {})[managerId];
    const mention = managerDiscordId ? `<@${managerDiscordId}> ` : "";
    await sendDiscord(
      workspace.discordWebhookUrl,
      `${mention}**New ${typeName} request** from **${employeeName}** is waiting for your approval.`
    );

    const managerSlackId = (workspace.slackUserMappings || {})[managerId];
    const slackMention = managerSlackId ? `<@${managerSlackId}> ` : "";
    await sendSlack(
      workspace.slackWebhookUrl,
      `${slackMention}New *${typeName}* request from *${employeeName}* is waiting for your approval.`
    );
  }

  console.log("[onRequestCreated] done.");
});

// TRIGGER 2: Request approved/rejected → notify employee
exports.onRequestUpdated = onDocumentUpdated("requests/{requestId}", async (event) => {
  init();
  const before = event.data.before.data();
  const after = event.data.after.data();

  console.log("[onRequestUpdated] fired. status:", before.status, "→", after.status);

  if (before.status === after.status) {
    console.log("[onRequestUpdated] status unchanged, skipping.");
    return;
  }
  if (after.status !== "approved" && after.status !== "rejected") {
    console.log("[onRequestUpdated] status not approved/rejected, skipping.");
    return;
  }

  const { userId, type, workspaceId } = after;
  if (!userId) {
    console.log("[onRequestUpdated] no userId, skipping.");
    return;
  }

  const typeName = requestTypeName(type);
  const isApproved = after.status === "approved";
  const statusWord = isApproved ? "approved" : "rejected";
  const emoji = isApproved ? "✅" : "❌";
  const managerNote = after.managerNote ? `\nManager note: *${after.managerNote}*` : "";

  // Get employee name
  const userDoc = await db.collection("users").doc(userId).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  const employeeName = `${userData.firstName || ""} ${userData.lastName || ""}`.trim() || "Employee";

  // FCM
  const token = await getToken(userId);
  console.log("[onRequestUpdated] employee fcmToken:", token ? "found" : "MISSING");
  await sendNotification(
    token,
    isApproved ? "Request Approved" : "Request Rejected",
    `Your ${typeName} request has been ${statusWord}`
  );

  // Discord + Slack
  const workspace = await getWorkspaceConfig(workspaceId);
  if (workspace) {
    const employeeDiscordId = (workspace.discordUserMappings || {})[userId];
    const mention = employeeDiscordId ? `<@${employeeDiscordId}> ` : "";
    await sendDiscord(
      workspace.discordWebhookUrl,
      `${emoji} ${mention}Your **${typeName}** request has been **${statusWord}**.${managerNote}`
    );

    const employeeSlackId = (workspace.slackUserMappings || {})[userId];
    const slackMention = employeeSlackId ? `<@${employeeSlackId}> ` : "";
    await sendSlack(
      workspace.slackWebhookUrl,
      `${emoji} ${slackMention}Your *${typeName}* request has been *${statusWord}*.${managerNote.replace(/\*/g, "")}`
    );
  }

  console.log("[onRequestUpdated] done.");
});
