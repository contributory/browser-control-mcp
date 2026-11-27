import { handleEdgeOne } from "../_runtime/transport/edgeone.js";

export default function onRequest(context) {
  return handleEdgeOne(context);
}
