/**
 * Draws a test page (tests/pages/<name>/index.html) with the runtime, for comparing against a
 * browser: BLOOM_PAGE=<dir> BLOOM_SCRIPT="60 shot out.png; 61 quit" .build/page-app
 * (configure() is in its own module: imports run before this module's code.)
 */
import "./page-config.ts";
import "../src/index.ts";
