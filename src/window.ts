/**
 * Opens the Bloom window, first of everything (index.ts imports this before the rest), so the
 * page's size (innerWidth, a full-window canvas's clientWidth) is known while the page installs.
 */
import { config } from "./config.ts";
import { openWindow } from "./frame.ts";

const c = config();
openWindow(c.width, c.height, c.title);
