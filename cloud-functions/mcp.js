import { handleServerless } from "./_runtime/transport/serverless.js";

// EdgeOne owns the HTTP listener. No persistent browser connection is assumed.
export default function onRequest(context) {
  return handleServerless(context.request, { ...process.env, ...context.env });
}
