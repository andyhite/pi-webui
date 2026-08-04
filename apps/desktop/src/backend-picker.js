// Plain JS, deliberately: this page is not bundled, it is loaded as a
// static file next to `backend-picker.html` (both copied verbatim into
// `dist/` by the build script), and it only calls the narrow bridge
// `backend-picker-preload.ts` exposes as `window.plotroomBackends`.

async function render() {
  const state = await window.plotroomBackends.list();
  document.getElementById("current-label").textContent = state.active
    ? `${state.active.label} (${state.active.url})`
    : "Local";

  const list = document.getElementById("backend-list");
  list.replaceChildren();
  for (const backend of state.backends) {
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = backend.label;

    const url = document.createElement("span");
    url.className = "url";
    url.textContent = backend.url;

    const switchButton = document.createElement("button");
    const isActive = state.active && state.active.id === backend.id;
    switchButton.textContent = isActive ? "Active" : "Switch to this";
    switchButton.disabled = Boolean(isActive);
    switchButton.className = isActive ? "active" : "";
    switchButton.addEventListener("click", async () => {
      await window.plotroomBackends.switchTo(backend.id);
    });

    const removeButton = document.createElement("button");
    removeButton.textContent = "Forget";
    removeButton.addEventListener("click", async () => {
      await window.plotroomBackends.remove(backend.id);
      await render();
    });

    li.append(label, url, switchButton, removeButton);
    list.append(li);
  }
}

document.getElementById("use-local").addEventListener("click", async () => {
  await window.plotroomBackends.switchTo(null);
});

document
  .getElementById("add-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.getElementById("status");
    status.textContent = "Testing connection\u2026";

    const label = document.getElementById("label").value.trim();
    const url = document.getElementById("url").value.trim();
    const credential = document.getElementById("credential").value;

    const result = await window.plotroomBackends.testAndRemember({
      label,
      url,
      credential: credential.length > 0 ? credential : null,
    });

    if (result.ok) {
      status.style.color = "#3a3";
      status.textContent = "Connected \u2014 remembered.";
      document.getElementById("add-form").reset();
      await render();
    } else {
      status.style.color = "#a33";
      status.textContent = result.reason;
    }
  });

void render();
