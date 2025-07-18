import { run } from "./main.mjs";
import { setFailed } from "@actions/core";

run().catch((err) => setFailed(err));
