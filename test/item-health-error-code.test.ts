import { test } from "node:test";
import assert from "node:assert/strict";
import { itemStatusFromError, plaidErrorCode } from "../src/health/items";

test("item health reads Plaid's error_code from plaidCall errors", () => {
  const current = 'Plaid /item/get failed: {"provider":"plaid","status":400,"error_type":"INVALID_INPUT","error_code":"INVALID_ACCESS_TOKEN","request_id":"x","message":"could not find matching access token"}';
  assert.equal(plaidErrorCode(current), "INVALID_ACCESS_TOKEN");
  assert.equal(itemStatusFromError(plaidErrorCode(current)), "needs_reauth");
  assert.equal(plaidErrorCode("Plaid error: ITEM_LOGIN_REQUIRED - the login details changed"), "ITEM_LOGIN_REQUIRED");
  assert.equal(plaidErrorCode("fetch failed"), "UNKNOWN");
});
