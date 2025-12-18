export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "96px 24px" }}>
      <div className="prose">
        <h1>StreamMDX</h1>
        <p>Documentation and demo site for StreamMDX.</p>
        <ul>
          <li>
            <a href="/docs">Docs</a>
          </li>
          <li>
            <a href="/demo">Demo</a>
          </li>
        </ul>
      </div>
    </main>
  );
}
