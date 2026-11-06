import { configure } from "../src/config.ts";
configure({ app: "bloom-web-tests", title: "page", width: 1280, height: 800, root: process.env["BLOOM_PAGE"] ?? "", storageFile: "/tmp/bloom-web-tests.json" });
