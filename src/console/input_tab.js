// Actor "Input" tab: schema-driven Form/JSON run-input editor.
//
// Split out of app.js so no single console script owns both the shell/
// routing/storage views and the entire schema-form engine. This is a
// second classic (non-module) script, sharing app.js's global scope like
// every other cross-file reference in this no-bundler console: `mk`, `api`,
// `unwrap` and `navigate` (defined in app.js) are used here directly, and
// `renderInputTab` below is what app.js's `openActor` calls to render the
// tab. index.html loads this file BEFORE app.js so `renderInputTab` exists
// as soon as app.js's own top-level code (its router's initial render) can
// reach it.
//
// DOM safety: same convention as app.js's own header comment -- untrusted,
// actor-controlled strings (schema titles/descriptions/enum labels/
// prefilled values) are set via textContent/mk, never innerHTML or an
// inline event-handler attribute. Mirrors the official console's own Actor
// "Input" tab: a schema-generated Form view and a raw JSON view, kept in
// sync, replacing the old bare browser-prompt run-input dialog (the removed
// `window.doRun`).

// Editor-type -> widget-kind mapping: a select/dropdown wins whenever the
// property declares an `enum` (regardless of its `editor`), `editor:
// "textarea"` gets a text area, integer/number/boolean get their obvious
// native control, an `array` with `editor: "stringList"` (or the URL-list
// `requestListSources` editor, treated identically) gets the add/remove
// row list, and EVERYTHING else -- `object`, any other array, any
// unrecognized editor -- degrades to a labeled JSON textarea scoped to
// just that one field, since a raw JSON sub-field is always a safe
// fallback: it shows and submits exactly the value that's there, even for
// a shape none of the dedicated widgets know how to render.
function inputWidgetKind(propSchema) {
  const type = propSchema && propSchema.type;
  const editor = propSchema && propSchema.editor;
  if (type === "string") {
    if (Array.isArray(propSchema.enum) && propSchema.enum.length) return "select";
    if (editor === "textarea") return "textarea";
    return "text";
  }
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array" && (editor === "stringList" || editor === "requestListSources")) return "stringList";
  return "json";
}

// A JSON->Form switch only rejects on parse failure / non-object shape --
// it never validates individual property values against their own
// property's schema. So a hand-edited JSON value that doesn't fit its
// dedicated widget (an enum value outside the declared options; a
// non-array value for a stringList; a non-boolean for a boolean; a
// non-number for a number; a non-string for a text/textarea) still lands in
// `formValues` untouched -- and the same can happen from a malformed
// schema-author `prefill`/`default` on first load, with no JSON edit
// involved at all. Rendering such a value through its normal dedicated
// widget anyway would either misrepresent it (a `<select>` silently falls
// back to its blank option when `.value` doesn't match any `<option>`; a
// non-array stringList renders zero rows; a non-numeric `current` fails
// `<input type=number>`'s value-sanitization and shows blank; a non-string
// renders via `String(current)`, e.g. "[object Object]") or, worse for a
// `boolean` that a checkbox is then allowed to write back to `formValues`,
// *actively overwrite* it: forcing the value to its nearest representable
// state (unchecked, i.e. `false`) and writing that back would silently
// replace the real value the moment the Form renders, with no user action
// at all.
//
// `widgetCanRepresent` is the single predicate `buildInputWidget` consults
// before committing to a kind's normal widget: a value it says "no" to
// falls back to the existing JSON-sub-field widget instead (which always
// shows -- and only ever writes -- exactly the value that will be
// submitted). `undefined` (nothing set yet) always passes for every kind --
// that's the widget's normal "seed from absent" case, not a mismatch.
//
// The render invariant this enforces, for every kind: the Form never
// displays a value different from what would be submitted. For every kind
// except boolean, rendering also never *adds* a key to `formValues` -- only
// a real user event (typing, an Add/Remove row, a select change) ever
// contributes a new value, matching the prefill-else-default-else-omit rule
// the state was seeded with in the first place. `boolean` carries one
// deliberate, narrower exception, scoped to
// REQUIRED properties only: a checkbox has just two DOM states -- checked
// or unchecked -- with no third "nothing set" state, so an untouched
// required boolean with no prefill/default would otherwise stay
// permanently unsatisfiable (rendered as an implicitly-false unchecked box
// that Start still refuses as "missing a value"). Rendering a required
// boolean therefore does write a real `true`/`false` into `formValues`
// immediately, so its own untouched state can satisfy validation. An
// OPTIONAL boolean gets no such exception -- it only ever contributes a
// value once one already exists (prefill, default, or a prior JSON edit) or
// once the user actually flips the checkbox, exactly like every other
// widget kind. See `buildInputWidget`'s `boolean` branch for where this
// split is applied.
function widgetCanRepresent(kind, propSchema, value) {
  if (value === undefined) return true;
  switch (kind) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      // `Number.isFinite` rejects non-numbers, `NaN`, and both `Infinity` /
      // `-Infinity` in one call -- an overflowed literal like `1e309` parses
      // to `Infinity`, which `<input type=number>` can't display (its
      // value-sanitization algorithm blanks it) even though it's `typeof
      // "number"` and not `NaN`, so a plain `!Number.isNaN` check would let
      // it through and break the render invariant this predicate exists to
      // enforce.
      return Number.isFinite(value);
    case "text":
    case "textarea":
      return typeof value === "string";
    case "select": {
      const options = Array.isArray(propSchema.enum) ? propSchema.enum : [];
      return options.some((opt) => String(opt) === String(value));
    }
    case "stringList":
      return Array.isArray(value);
    default:
      return true; // "json" (and anything else) always represents faithfully.
  }
}

// Prefill wins over default; a property with neither is reported absent
// (`has: false`) so the caller can OMIT it entirely from the seeded state,
// rather than writing null/"".
function inputPrefillOrDefault(propSchema) {
  if (propSchema && Object.prototype.hasOwnProperty.call(propSchema, "prefill")) {
    return { has: true, value: propSchema.prefill };
  }
  if (propSchema && Object.prototype.hasOwnProperty.call(propSchema, "default")) {
    return { has: true, value: propSchema.default };
  }
  return { has: false, value: undefined };
}

// Required-field emptiness for Start-time validation: false/0 are real
// values, not "empty" -- only absent/null/""/an empty array count.
function isEmptyFormValue(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

// `array` + `editor: "stringList"` (or `requestListSources`): one text row
// per array entry, plus add/remove affordances. `formValues[key]` is only
// ever written by `sync()`, itself only called from a real user
// interaction (typing a row, or Add/Remove) -- so an untouched, unprefilled
// list field stays absent from `formValues` (and therefore omitted from the
// JSON view) until the user actually interacts with it.
function buildStringListWidget(key, formValues) {
  const wrap = mk("div", { class: "string-list" });
  const rowsBox = mk("div", { class: "string-list-rows" });

  // Blank-means-omit (matching the JSON-subfield widget's convention, and
  // now every other widget's -- see buildInputWidget below): an untyped row
  // (added via "Add" but never typed into, or cleared back to empty) doesn't
  // count as a real list entry, so it's dropped before writing back to
  // `formValues` -- otherwise clicking "Add" once would satisfy a required
  // list field with nothing actually entered. Rows stay visible in the DOM
  // exactly as the user left them; only the derived value is filtered. Once
  // every row is blank (including zero rows), the key is omitted entirely
  // rather than sending an explicit `[]`.
  function sync() {
    const values = Array.from(rowsBox.querySelectorAll("input"))
      .map((i) => i.value)
      .filter((v) => v !== "");
    if (values.length === 0) delete formValues[key];
    else formValues[key] = values;
  }

  function addRow(value, touch) {
    const row = mk("div", { class: "string-list-row" });
    const input = document.createElement("input");
    input.type = "text";
    input.value = value == null ? "" : String(value);
    input.addEventListener("input", sync);
    row.append(
      input,
      mk("button", { class: "secondary", text: "Remove", onClick: () => { row.remove(); sync(); } }),
    );
    rowsBox.appendChild(row);
    if (touch) sync();
  }

  (Array.isArray(formValues[key]) ? formValues[key] : []).forEach((v) => addRow(v, false));
  wrap.append(rowsBox, mk("button", { class: "secondary", text: "Add", onClick: () => addRow("", true) }));
  return wrap;
}

// `object`, any other array, or any unrecognized `editor`: a labeled JSON
// textarea scoped to just this one property. A blank textarea means "omit
// this key" (deletes it from `formValues`) rather than a parse error, since
// an empty string is never valid JSON but is an entirely reasonable way to
// say "no value here". Otherwise invalid JSON marks `key` in `invalidFields`
// (checked at Start time in Form mode) without touching the field's last
// good value -- so a mid-edit typo never silently drops previously-entered
// data.
function buildJsonFieldWidget(key, formValues, invalidFields) {
  const wrap = mk("div", { class: "json-subfield" });
  const textarea = document.createElement("textarea");
  textarea.rows = 4;
  const errorEl = mk("div", { class: "input-error" });
  if (Object.prototype.hasOwnProperty.call(formValues, key)) {
    textarea.value = JSON.stringify(formValues[key], null, 2);
  }
  textarea.addEventListener("input", () => {
    const text = textarea.value;
    if (text.trim() === "") {
      delete formValues[key];
      invalidFields.delete(key);
      errorEl.textContent = "";
      return;
    }
    try {
      formValues[key] = JSON.parse(text);
      invalidFields.delete(key);
      errorEl.textContent = "";
    } catch (e) {
      invalidFields.add(key);
      errorEl.textContent = "Invalid JSON for this field.";
    }
  });
  wrap.append(textarea, errorEl);
  return wrap;
}

// One property -> one widget, per `inputWidgetKind`. Every widget writes its
// current value into `formValues[key]` directly from its own event handler
// (never returned/polled), so `formValues` is always the live source of
// truth for both Form->JSON serialization and Start-time validation -- with
// one narrow exception, a REQUIRED boolean, which also writes at render
// time (see the `boolean` branch below and the comment above
// `widgetCanRepresent`).
function buildInputWidget(key, propSchema, formValues, invalidFields, required) {
  const kind = inputWidgetKind(propSchema);
  const current = Object.prototype.hasOwnProperty.call(formValues, key) ? formValues[key] : undefined;
  // A value this kind's dedicated widget can't represent faithfully (see the
  // module comment above `widgetCanRepresent`) falls back to the JSON
  // sub-field instead. `"json"` and any unrecognized kind always pass this
  // check, so they still fall through to their own branch below unaffected.
  if (!widgetCanRepresent(kind, propSchema, current)) return buildJsonFieldWidget(key, formValues, invalidFields);

  if (kind === "boolean") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = current === true;
    // `current` is guaranteed a real boolean or absent by the guard above.
    // Required writes true/false into formValues immediately on every
    // render (a checkbox has no "nothing set" state); optional only writes
    // once a value already exists or the user toggles it -- see the
    // module-level comment above `widgetCanRepresent` for the full rationale.
    if (required || current !== undefined) formValues[key] = input.checked;
    input.addEventListener("change", () => { formValues[key] = input.checked; });
    return input;
  }
  if (kind === "number") {
    const wrap = mk("div", { class: "input-number" });
    const input = document.createElement("input");
    input.type = "number";
    if (current != null) input.value = String(current);
    const errorEl = mk("div", { class: "input-error" });
    input.addEventListener("input", () => {
      // Blank-means-omit (matching every other widget below): a cleared
      // number field drops the key instead of sending `""`.
      if (input.value === "") {
        delete formValues[key];
        invalidFields.delete(key);
        errorEl.textContent = "";
        return;
      }
      const n = Number(input.value);
      if (!Number.isFinite(n)) {
        // Unparseable-but-nonempty (e.g. a mid-exponent-entry like "1e"), or
        // parseable but not finite (an overflowed literal like `1e309`,
        // which `Number()` happily parses to `Infinity`): mirror the
        // JSON-subfield widget's `invalidFields` convention -- mark the key
        // invalid and leave its last good value untouched, rather than
        // storing a non-finite number the input can't actually display and
        // `JSON.stringify` would submit as `null`. Blocks Start (see the
        // invalidFields.size check below) with an inline error naming the
        // field, instead of silently POSTing `null` for a numeric property.
        invalidFields.add(key);
        errorEl.textContent = "Not a valid number.";
        return;
      }
      formValues[key] = n;
      invalidFields.delete(key);
      errorEl.textContent = "";
    });
    wrap.append(input, errorEl);
    return wrap;
  }
  if (kind === "select") {
    const select = document.createElement("select");
    const blank = mk("option", { text: "" });
    blank.value = "";
    select.appendChild(blank);
    const options = Array.isArray(propSchema.enum) ? propSchema.enum : [];
    const titles = Array.isArray(propSchema.enumTitles) ? propSchema.enumTitles : [];
    options.forEach((opt, i) => {
      const optionEl = mk("option", { text: titles[i] != null ? String(titles[i]) : String(opt) });
      optionEl.value = opt;
      select.appendChild(optionEl);
    });
    // Selection is tracked by index, not by `.value`: the blank "unset"
    // option is always index 0, but a schema could in principle declare a
    // real enum member whose value is itself the literal empty string,
    // which would otherwise share `value=""` with the blank option and be
    // indistinguishable from "nothing selected" (no schema in this repo
    // does this today, but nothing stops one from doing so). Looking the
    // match up in `options` directly, rather than comparing `select.value`,
    // means index 0 unambiguously means unset even when that collision
    // exists.
    const matchIdx = current != null ? options.findIndex((opt) => String(opt) === String(current)) : -1;
    select.selectedIndex = matchIdx >= 0 ? matchIdx + 1 : 0;
    select.addEventListener("change", () => {
      // Blank-means-omit: picking the blank option (always index 0) drops
      // the key; otherwise write the original enum entry (not
      // `select.value`, which would coerce a non-string enum value to text).
      if (select.selectedIndex === 0) delete formValues[key];
      else formValues[key] = options[select.selectedIndex - 1];
    });
    return select;
  }
  if (kind === "textarea") {
    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    if (current != null) textarea.value = String(current);
    textarea.addEventListener("input", () => {
      // Blank-means-omit: an emptied textarea drops the key.
      if (textarea.value === "") delete formValues[key];
      else formValues[key] = textarea.value;
    });
    return textarea;
  }
  if (kind === "stringList") return buildStringListWidget(key, formValues);
  if (kind === "json") return buildJsonFieldWidget(key, formValues, invalidFields);

  // Plain single-line text input -- the default for a bare `string`.
  const input = document.createElement("input");
  input.type = "text";
  if (current != null) input.value = String(current);
  input.addEventListener("input", () => {
    // Blank-means-omit (matching the JSON-subfield/stringList widgets'
    // convention): a cleared field drops the key from the payload instead of
    // sending an explicit `""`.
    if (input.value === "") delete formValues[key];
    else formValues[key] = input.value;
  });
  return input;
}

// One field's label (schema `title`, else the raw key), required marker,
// description helper text, then its widget.
function inputFieldRowEl(key, propSchema, required, widgetEl) {
  const row = mk("div", { class: "input-field" });
  const labelRow = mk("div", { class: "input-field-label" });
  labelRow.appendChild(mk("label", { text: (propSchema && propSchema.title) || key }));
  if (required) labelRow.appendChild(mk("span", { class: "input-required", text: " *" }));
  row.appendChild(labelRow);
  if (propSchema && propSchema.description) {
    row.appendChild(mk("div", { class: "input-field-help muted", text: propSchema.description }));
  }
  row.appendChild(widgetEl);
  return row;
}

// Renders every property's field row, in schema declaration order, grouped
// under a `sectionCaption` heading (with its `sectionDescription` as helper
// text) wherever one appears -- a group stays open until the next property
// that declares its own `sectionCaption`. Iterates via `Object.entries`,
// which preserves declared order except for the rare bare-integer-named
// property key (e.g. "0"), which JS enumerates numerically first per spec.
function renderFormFields(container, properties, requiredKeys, formValues, invalidFields) {
  let currentCaption = null;
  let sectionBody = null;
  for (const [key, propSchema] of Object.entries(properties)) {
    const caption = propSchema && propSchema.sectionCaption;
    if (caption && caption !== currentCaption) {
      currentCaption = caption;
      const section = mk("div", { class: "input-section" });
      section.appendChild(mk("h3", { text: caption }));
      if (propSchema.sectionDescription) {
        section.appendChild(mk("div", { class: "muted", text: propSchema.sectionDescription }));
      }
      container.appendChild(section);
      sectionBody = section;
    }
    const required = requiredKeys.has(key);
    const widget = buildInputWidget(key, propSchema, formValues, invalidFields, required);
    (sectionBody || container).appendChild(inputFieldRowEl(key, propSchema, required, widget));
  }
}

// The Input tab itself: fetches the actor's resolved schema exactly ONCE
// (this function runs once per navigation to the tab -- see `openActor`),
// then keeps a single in-memory {mode, formValues, jsonText, unknownKeys}
// state for the rest of the visit. Every subsequent edit or Form/JSON
// switch mutates that state and re-renders locally with NO further network
// request, until Start (or a Refresh/re-navigation) is clicked.
async function renderInputTab(actorId, container) {
  const schema = unwrap(await api(`/v2/acts/${actorId}/input-schema`));
  const hasSchema = schema != null && typeof schema === "object" && !Array.isArray(schema);
  const properties =
    hasSchema && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  // Only enforce required-ness for keys that actually render a widget: a
  // `required` entry naming a property absent from `properties` is legal
  // JSON Schema (nothing here validates the schema itself), but
  // `renderFormFields` only ever renders a widget for keys present in
  // `properties` -- so an un-filtered `requiredKeys` could name a field the
  // Form never shows a control for, permanently blocking Start with no way
  // to satisfy it.
  const requiredKeys = new Set(
    hasSchema && Array.isArray(schema.required)
      ? schema.required.filter((k) => Object.prototype.hasOwnProperty.call(properties, k))
      : [],
  );

  // Seed initial state (prefill else default else omit): only properties
  // declaring one or the other are present here at all.
  //
  // `Object.create(null)` rather than `{}`: a schema property literally
  // named `__proto__` must land as a normal own key here. On a plain `{}`,
  // `formValues["__proto__"] = value` doesn't create an own property at all
  // -- it hits `Object.prototype`'s `__proto__` accessor and silently
  // mutates (or no-ops on) the object's prototype instead. A null-prototype
  // object has no such accessor in its chain, so bracket assignment always
  // creates a genuine own data property, for any key name. Every other
  // bracket-written lookup map in this tab (`unknownKeys` and the
  // `nextFormValues`/`nextUnknown` locals below) gets the same treatment for
  // the same reason.
  const formValues = Object.create(null);
  for (const [key, propSchema] of Object.entries(properties)) {
    const pd = inputPrefillOrDefault(propSchema);
    if (pd.has) formValues[key] = pd.value;
  }
  let unknownKeys = Object.create(null);
  const invalidFields = new Set();
  let mode = hasSchema ? "form" : "json";
  let jsonText = JSON.stringify(formValues, null, 2);

  const modeRow = mk("div", { class: "tabs" });
  const switchErrorEl = mk("div", { class: "input-error" });
  const bodyEl = mk("div");
  const startErrorEl = mk("div", { class: "input-error" });
  const startBtn = mk("button", { text: "Start" });
  const startRow = mk("div", { class: "row" });
  startRow.append(startBtn, startErrorEl);

  // Current full payload = schema-known fields (formValues) plus whatever
  // schema-unknown keys the JSON side last held (round-tripped, never
  // dropped just because the Form has no widget for them).
  //
  // Merge target is `Object.create(null)`, not `{}`, for the same
  // __proto__-safety reason as `formValues`/`unknownKeys` above: `Object
  // .assign` writes into the target via normal property assignment, so a
  // literal `__proto__` key from either source would otherwise vanish (or
  // repoison the *merged* object's prototype) the moment it lands on an
  // ordinary-prototype target, even though the source maps hold it safely.
  function currentPayload() {
    return Object.assign(Object.create(null), unknownKeys, formValues);
  }

  function renderModeRow() {
    modeRow.innerHTML = "";
    if (!hasSchema) return; // No-schema/TARBALL actor: JSON-only, no toggle.
    modeRow.append(
      mk("span", { class: mode === "form" ? "active" : "", text: "Form", onClick: () => switchMode("form") }),
      mk("span", { class: mode === "json" ? "active" : "", text: "JSON", onClick: () => switchMode("json") }),
    );
  }

  function renderBody() {
    bodyEl.innerHTML = "";
    if (mode === "form") {
      renderFormFields(bodyEl, properties, requiredKeys, formValues, invalidFields);
      if (!Object.keys(properties).length) {
        bodyEl.appendChild(mk("p", { class: "muted", text: "This schema declares no properties." }));
      }
    } else {
      const textarea = document.createElement("textarea");
      textarea.id = "input-json-editor";
      textarea.rows = 16;
      textarea.value = jsonText;
      textarea.addEventListener("input", () => { jsonText = textarea.value; });
      bodyEl.appendChild(textarea);
    }
  }

  // Form->JSON always succeeds. JSON->Form parses; on failure the switch
  // is blocked IN PLACE -- mode/formValues/jsonText all stay exactly
  // as they were, and the JSON textarea's own DOM content is never touched
  // (renderBody() is only called on the success path), so the just-typed
  // text survives untouched.
  function switchMode(next) {
    switchErrorEl.textContent = "";
    startErrorEl.textContent = "";
    if (next === mode) return;
    if (next === "json") {
      jsonText = JSON.stringify(currentPayload(), null, 2);
      mode = "json";
    } else {
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (e) {
        switchErrorEl.textContent = `Cannot switch to Form view: the JSON is not valid (${e.message}).`;
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        switchErrorEl.textContent = "Cannot switch to Form view: the JSON must be an object.";
        return;
      }
      const nextFormValues = Object.create(null);
      const nextUnknown = Object.create(null);
      for (const [k, v] of Object.entries(parsed)) {
        if (Object.prototype.hasOwnProperty.call(properties, k)) nextFormValues[k] = v;
        else nextUnknown[k] = v;
      }
      Object.keys(formValues).forEach((k) => delete formValues[k]);
      Object.assign(formValues, nextFormValues);
      unknownKeys = nextUnknown;
      invalidFields.clear();
      mode = "form";
    }
    renderModeRow();
    renderBody();
  }

  startBtn.addEventListener("click", async () => {
    startErrorEl.textContent = "";
    let payload;
    if (mode === "json") {
      try {
        payload = JSON.parse(jsonText);
      } catch (e) {
        startErrorEl.textContent = `Cannot start: the JSON is not valid (${e.message}).`;
        return;
      }
    } else {
      if (invalidFields.size) {
        // Shared by the JSON-subfield widget (invalid JSON) and the number
        // widget (an unparseable-but-nonempty value) -- both add to this
        // same set, so the message names the field(s) without assuming
        // which kind of "invalid" applies.
        startErrorEl.textContent = `Cannot start: fix invalid value(s) in ${Array.from(invalidFields).join(", ")}.`;
        return;
      }
      const missing = Array.from(requiredKeys).filter((k) => isEmptyFormValue(formValues[k]));
      if (missing.length) {
        startErrorEl.textContent = `Cannot start: required field(s) missing a value: ${missing.join(", ")}.`;
        return;
      }
      payload = currentPayload();
    }
    startBtn.disabled = true;
    try {
      await api(`/v2/acts/${actorId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      // Leave the button disabled through the scheduled navigation below --
      // re-enabling it here (right as the POST resolves) would let a fast
      // second click fire another run before the page actually moves away.
      setTimeout(() => navigate(`/actors/${actorId}/runs`), 500);
    } catch (e) {
      startBtn.disabled = false;
      startErrorEl.textContent = `Cannot start: ${e.message}.`;
    }
  });

  renderModeRow();
  renderBody();
  container.append(modeRow, switchErrorEl, bodyEl, startRow);
}
