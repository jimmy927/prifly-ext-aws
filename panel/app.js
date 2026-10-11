// The panel's page. It asks its extension for data at `api/<path>` beside
// itself; prifly answers from the module's `panel` export (index.ts) as JSON.

const list = document.getElementById("things");
const error = document.getElementById("error");

async function show() {
  const response = await fetch("api/things");
  const body = await response.json();
  if (!response.ok) {
    error.hidden = false;
    error.textContent = body.error ?? `HTTP ${response.status}`;
    return;
  }
  list.replaceChildren(
    ...body.things.map((thing) => {
      const item = document.createElement("li");
      item.textContent = `${thing.title} (${thing.column})`;
      return item;
    }),
  );
}

void show();
