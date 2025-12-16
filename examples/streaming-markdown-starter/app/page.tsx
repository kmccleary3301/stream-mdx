import StreamingDemo from "../components/StreamingDemo";

export default function Page() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header className="space-y-2">
        <p className="text-gray-500 text-sm uppercase tracking-wide">Example</p>
        <h1 className="font-semibold text-3xl text-gray-900">Streaming Markdown Starter</h1>
        <p className="text-gray-600">Type in the textarea or toggle the MDX compilation strategy to see how the renderer behaves.</p>
      </header>
      <StreamingDemo />
    </main>
  );
}
