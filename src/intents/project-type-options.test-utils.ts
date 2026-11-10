/**
 * Project type options for tests: git's and the fake type's, sealed — what the
 * app has after app:start once both types answered `register-project-types`.
 */

import { sealedProjectTypeOptions, type ProjectTypeOptions } from "./project-type-options";
import { GIT_PROJECT_OPTIONS } from "../modules/git/options";
import { FAKE_PROJECT_OPTIONS } from "../modules/fake-project-type.test-utils";

export function testProjectTypes(): ProjectTypeOptions {
  return sealedProjectTypeOptions(GIT_PROJECT_OPTIONS, FAKE_PROJECT_OPTIONS);
}
