const { Resend } = require('resend');
const { SecretsManager } = require("@aws-sdk/client-secrets-manager");

const sm = new SecretsManager();

async function getResendApiKey() {
  const secretName = process.env.RESEND_API_KEY_SECRET_NAME;

  if (!secretName) {
    console.error("RESEND_API_KEY_SECRET_NAME is not set in the environment variables");
    throw new Error("RESEND_API_KEY_SECRET_NAME is not set in the environment variables");
  }

  try {
    const secret = await sm.getSecretValue({ SecretId: secretName });
    return secret.SecretString;
  } catch (error) {
    console.error("Error retrieving secret:", error);
    throw error;
  }
}

function sendEmail(resend, { name, email, message }) {
  console.log("Sending email with data:", JSON.stringify({ name, email, message }));
  return resend.emails.send({
    from: "portfoliocontact@resend.dev",
    to: "fialloschris1@gmail.com",
    subject: "New Contact Form Submission",
    html: `
      <h1>${name} contacted you through your portfolio contact form.</h1>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Message:</strong> ${message}</p>
    `,
  });
}

function parseEventBody(event) {
  console.log("Parsing event body:", JSON.stringify(event));
  if (typeof event.body === 'string') {
    return JSON.parse(event.body);
  } else if (typeof event.body === 'object') {
    return event.body;
  } else {
    throw new Error('Invalid event body');
  }
}

function validateBody(body) {
  console.log("Validating body:", JSON.stringify(body));
  const { name, email, message } = body;

  if (!name || !email || !message) {
    throw new Error("Missing required fields");
  }

  return body;
}

function createResponse(statusCode, message, error = null, origin) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
    body: JSON.stringify({ message, ...(error && { error: error.toString() })}),
  };
}

exports.handler = async (event) => {
  console.log("Received event:", JSON.stringify(event));

  const origin = event.headers.origin || event.headers.Origin;

  // Handle preflight requests
  if (event.requestContext.http.method === 'OPTIONS') {
    return createResponse(200, 'Preflight request successful', null, origin);
  }

  try {
    const key = await getResendApiKey();
    const resend = new Resend(key);
    const body = parseEventBody(event);
    const validatedBody = validateBody(body);
    const result = await sendEmail(resend, validatedBody);
    console.log("Email sent successfully:", JSON.stringify(result));
    return createResponse(200, "Email sent successfully", null, origin);
  } catch (error) {
    console.error("Lambda function error:", error);
    return createResponse(500, "Internal server error", error, origin);
  }
};