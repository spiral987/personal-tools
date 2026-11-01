import type {Note} from "./index.ts";

export const ATLAS_REQUESTS_SPACE_NAME = "Atlas要望";

// Stored inside the encrypted, account-specific local database. The space ID
// is bound only by an explicit action, never rediscovered by name on export.
export type AtlasRequestSharing = {spaceId: string; shareId: string};

export type AtlasRequestsExport = {
    format: "personal-tools.atlas-requests";
    version: 1;
    mode: "snapshot";
    scope: typeof ATLAS_REQUESTS_SPACE_NAME;
    shareId: string;
    exportedAt: string;
    notes: Pick<Note, "id" | "body" | "updatedAt">[];
};
