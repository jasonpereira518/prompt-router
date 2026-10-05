import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
const rl = createInterface({ input: stdin, output: stdout });
// Terminal input is hidden; the output is a one-way hash, never the password.
rl._writeToOutput = function (text) {
  if (!this.hideInput) stdout.write(text);
};
stdout.write("Choose the owner password (at least 12 characters): ");
rl.hideInput = true;
const password = await rl.question("");
rl.hideInput = false;
rl.close();
stdout.write("\n");
if (password.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
const salt = randomBytes(16).toString("hex");
console.log(
  `OWNER_PASSWORD_HASH=${salt}:${scryptSync(password, salt, 64).toString("hex")}`,
);
