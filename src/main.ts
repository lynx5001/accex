/** Frontend entry point. */
import "./styles/main.css";

import { announceError } from "./accessibility/announcer";
import { bootstrap, errorMessage } from "./app";

document.addEventListener("DOMContentLoaded", () => {
  bootstrap()
    .start()
    .catch((err) => announceError(errorMessage(err)));
});
