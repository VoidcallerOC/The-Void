import { getVercelHandler } from "../server/vercel-handler.js";

export const config = { maxDuration: 60 };

export default async function handler(request, response) {
  return getVercelHandler()(request, response);
}
