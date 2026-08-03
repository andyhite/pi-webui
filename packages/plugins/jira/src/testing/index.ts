/**
 * The recorded Jira, exported so tests — in this package and in any future substrate
 * test — drive the plugin without the network (§9.3, and `@plotroom/plugin-github`'s
 * recorded GitHub, same reason).
 */
export {
  createRecordedJira,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_BUG,
  FIXTURE_CREDENTIAL,
  FIXTURE_EMAIL,
  FIXTURE_EPIC,
  FIXTURE_SITE,
  FIXTURE_TICKET,
  FIXTURE_TOKEN,
  type RecordedJira,
} from "./jira-fixture.js";
