import { createMetadataPostHandler } from "../../../lib/server/metadata-route.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The URL is submitted in a bounded POST body; it never becomes a logged route query.
// Next Route Handlers: https://nextjs.org/docs/app/api-reference/file-conventions/route
export const POST = createMetadataPostHandler();
