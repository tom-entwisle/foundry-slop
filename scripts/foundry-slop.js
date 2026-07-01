const MODULE_ID = "foundry-slop";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
});
