const TELEMETRY_URL   = "https://script.google.com/macros/s/AKfycbxzUHUVoXFQW9Hh2cUMKeIhmNWNLPHU2nSKS_yDO3CLYNpfmvGMuyeH8Y8jypvbdAQ/exec";
const TELEMETRY_TOKEN = "oe-reg-2026-openenterprise";

async function sendRegistration({ email, company, instanceId, version, event = "first_boot" }) {
  try {
    await fetch(TELEMETRY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TELEMETRY_TOKEN, email, company, instanceId, version, event }),
    });
  } catch {
    // silent fail — never block the user
  }
}

module.exports = { sendRegistration };
