/**
 * The recorded GitHub, exported so tests — in this package and in any future
 * substrate test — drive the plugin without the network (§9.3, `@plotroom/core`'s
 * scripted-runtime arrangement, same reason).
 */
export {
  createRecordedGitHub,
  FIXTURE_HEAD_SHA,
  FIXTURE_TOKEN,
  FIXTURE_UNCHECKED_SHA,
  type RecordedGitHub,
} from "./github-fixture.js";
