import { direct } from './tooling.mjs';
import { checkPackage } from './check.mjs';
import { typecheck } from './typecheck.mjs';
import { testPackage } from './test.mjs';

export function verify() {
  const checked = checkPackage();
  typecheck();
  const metrics = testPackage();
  console.log(JSON.stringify({ verify: 'PASS', packageFiles: checked.packageFiles, metrics }));
}
if (direct(import.meta.url)) verify();
