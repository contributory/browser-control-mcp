import { handleServerless } from "../_runtime/transport/serverless.js";

export default function onRequest(context) {
  return handleServerless(context.request, { ...process.env, ...context.env }, { nativeBodyReader: true });
}
