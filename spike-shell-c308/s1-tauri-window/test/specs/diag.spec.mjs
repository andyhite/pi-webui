describe("diag", () => {
  it("dumps page state", async () => {
    await browser.pause(3000);
    const url = await browser.execute(() => location.href);
    const title = await browser.execute(() => document.title);
    const bodyLen = await browser.execute(() => document.body.innerHTML.length);
    const readyState = await browser.execute(() => document.readyState);
    const hasTauri = await browser.execute(() => typeof window.__TAURI__);
    console.log(
      "DIAG",
      JSON.stringify({ url, title, bodyLen, readyState, hasTauri }),
    );
  });
});
