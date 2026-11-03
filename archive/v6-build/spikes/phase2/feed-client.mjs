const [url] = process.argv.slice(2);
const res = await fetch(url);
const decoder = new TextDecoder();
let buf = "";
process.on("uncaughtException", () => process.exit(0));
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const event = block.match(/^event: (.*)$/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    if (event !== "session" || !data) continue;
    const s = JSON.parse(data);
    console.log(JSON.stringify({ t: Date.now(), hook: s.last_hook, tool: s.last_tool, state: s.state, usage: s.usage }));
  }
}
