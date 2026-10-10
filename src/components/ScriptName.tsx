import { useEffect, useRef, useState } from "react";

// Shown in the emptied field, which is sized to fit it.
const PLACEHOLDER = "scene name";
const MAX_WORDS = 10;

/**
 * A name as the actor may type it: letters (any script), numbers and
 * spaces, at most MAX_WORDS words. Only the default name — the PDF's own
 * file name — may have anything else (".pdf", underscores); editing it
 * applies these rules. Pasted line breaks become spaces.
 */
function cleanScriptName(value: string): string {
  const allowed = value.replace(/\s/g, " ").replace(/[^\p{L}\p{N} ]/gu, "");
  // Up to the end of the last allowed word; a trailing space survives below
  // the limit, so the next word can still be typed.
  return allowed.match(new RegExp(`^ *(?:\\S+ +){0,${MAX_WORDS - 1}}\\S*`))?.[0] ?? allowed;
}

/**
 * A script's name wherever the app refers to it. With `onRename` it's
 * editable in place: click to edit, Enter or clicking away saves, Escape
 * cancels. A blank or unchanged name is dropped. A long name wraps onto
 * more lines while it's edited (except where the surrounding text keeps it
 * to one line, like a header). Takes its type from the
 * surrounding text (a heading, a caption), so it reads as part of it.
 */
export default function ScriptName({
  name,
  onRename,
  onEditingChange,
}: {
  name: string;
  onRename?: (next: string) => void;
  /** Told when editing starts and ends, e.g. to set other controls aside. */
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Enter commits and then blurs; the blur mustn't commit a second time.
  const settledRef = useRef(false);
  // What editing started from; only a change from it is a rename.
  const startRef = useRef("");

  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;
  useEffect(() => {
    onEditingChangeRef.current?.(editing);
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    // The whole name selected, ready to type over. No scroll: the field
    // already sits where the name was.
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [editing]);

  if (!onRename) return <span className="script-name">{name}</span>;

  const finish = (save: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    const next = draft.trim();
    if (save && next && next !== startRef.current.trim()) onRename(next);
    setEditing(false);
    // Back on the name, so keyboard users don't lose their place.
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  if (editing) {
    // The field is exactly the size of the text: an invisible copy of the
    // draft sizes it (capped at the line's width, wrapping past it), so the
    // heading keeps its shape and nothing overflows the page while editing.
    return (
      <span className="script-name-editor">
        <span className="script-name-sizer" aria-hidden="true">
          {draft || PLACEHOLDER}
        </span>
        <textarea
          ref={inputRef}
          className="script-name script-name-input"
          aria-label="Script name"
          aria-description={`Letters, numbers and spaces, up to ${MAX_WORDS} words`}
          placeholder={PLACEHOLDER}
          rows={1}
          value={draft}
          onChange={(event) => setDraft(cleanScriptName(event.target.value))}
          onBlur={() => finish(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // A name is one line: Enter saves rather than breaking it.
              event.preventDefault();
              finish(true);
            } else if (event.key === "Escape") finish(false);
          }}
        />
        {/* At the end of the underline: this is being edited. */}
        <svg
          className="script-name-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </span>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className="script-name script-name-button"
      title="Rename script"
      aria-label={`${name}, rename script`}
      onClick={() => {
        settledRef.current = false;
        // The default name (the PDF's file name) is tidied into an allowed
        // one to edit from: no ".pdf", separators as spaces.
        const start = cleanScriptName(name.replace(/\.pdf$/i, "").replace(/[_.-]+/g, " "));
        startRef.current = start;
        setDraft(start);
        setEditing(true);
      }}
    >
      {name}
    </button>
  );
}
