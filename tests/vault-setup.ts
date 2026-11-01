// Every repository test uses the same production encryption boundary.
import {createVault} from "../packages/api-client/src/vault.ts";
await createVault("test-only-passphrase-never-used-for-user-data");
