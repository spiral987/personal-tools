import test from "node:test";
import assert from "node:assert/strict";
import {trashPurgeAt,trashIsExpired} from "../packages/core/src/lifecycle.ts";
test("trash retention: one Japan calendar month clamps month end, including leap years",()=>{
 for(const [input,expected] of [
  ["2026-10-31T12:34:56.789+09:00","2026-11-30T12:34:56.789+09:00"],
  ["2026-03-31T00:30:00+09:00","2026-04-30T00:30:00+09:00"],
  ["2026-01-31T23:59:59+09:00","2026-02-28T23:59:59+09:00"],
  ["2028-01-31T10:00:00+09:00","2028-02-29T10:00:00+09:00"],
  ["2026-12-31T01:00:00+09:00","2027-01-31T01:00:00+09:00"],
 ])assert.equal(trashPurgeAt(input),new Date(expected).toISOString());
 assert.throws(()=>trashPurgeAt("invalid"));
});
test("trash retention: exact deadline expires, restore clears it, re-trash starts a new month",()=>{
 const record={kind:"note",deletedAt:"2026-10-31T00:30:00+09:00"} as any,deadline=Date.parse(trashPurgeAt(record.deletedAt));
 assert.equal(trashIsExpired(record,deadline-1),false);assert.equal(trashIsExpired(record,deadline),true);
 assert.equal(trashIsExpired({...record,deletedAt:null},deadline+1),false);
 assert.equal(trashIsExpired({...record,deletedAt:"2026-11-29T00:30:00+09:00"},deadline+1),false);
});
