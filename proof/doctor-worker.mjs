// Doctor child worker for the PR #150837 proof probe. Runs on the checked-out
// tree's own production code (createUpdatePostInstallDoctorResultPath +
// writeUpdatePostInstallDoctorResult) so the BEFORE/AFTER behavior difference
// comes from real source, not from the probe.
import {
  createUpdatePostInstallDoctorResultPath,
  writeUpdatePostInstallDoctorResult,
} from "../src/infra/update-doctor-result.js";

const warning = process.argv[2] ?? "";
const resultPath = createUpdatePostInstallDoctorResultPath();
await writeUpdatePostInstallDoctorResult({
  resultPath,
  result: { status: "ok", warnings: [warning] },
});
console.log(`DOCTOR_RESULT_PATH=${resultPath}`);
