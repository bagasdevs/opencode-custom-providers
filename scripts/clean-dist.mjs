// tsc only adds files to outDir, so anything whose source was renamed or deleted stays
// behind and ships. A QA harness written by hand once ended up in the published tarball
// that way, carrying the author's absolute home path. Clear the generated directory
// before every build so dist/ can only ever hold what src/ produces.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
rmSync(dist, { recursive: true, force: true });
