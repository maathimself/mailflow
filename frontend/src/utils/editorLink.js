import { Link } from '@tiptap/extension-link';

// The composer's link mark.
//
// Why this is not just StarterKit's Link (#415)
// ---------------------------------------------
// extension-link declares:
//
//   inclusive() { return this.options.autolink }   // autolink defaults to true
//
// An INCLUSIVE mark absorbs text typed at its trailing edge. Typed URLs escape that by
// accident: the autolink plugin only fires once the change ends in whitespace, and it
// applies the mark with addMark over the URL range only, so by the time the link exists
// the caret already sits past a space and outside the mark.
//
// A PASTED url takes a different route. It is marked immediately by the extension's paste
// rule, which leaves the caret exactly on the mark's boundary, i.e. inside an inclusive
// mark. Everything typed next is swallowed into the link, and because the composer's HTML
// is what gets sent, the recipient receives an anchor wrapping text that was never meant
// to be a link:
//
//   <a href="https://example.com">https://example.com and the rest of the sentence</a>
//
// It is not specific to the space key. Any character typed at the boundary is absorbed.
//
// Making the mark non-inclusive fixes both halves and costs nothing, because nothing here
// depends on inclusivity: autolink applies marks with addMark over ranges it computes
// itself. Turning it off only stops a link growing into text the user types after it,
// which was never correct anyway, the href stayed pointing at the original URL while the
// visible text kept growing.
//
// autolink itself stays ON. See editorLink.test.js, which pins both the schema flag and
// the actual typing behaviour so a TipTap upgrade cannot quietly reintroduce this.
export const ComposerLink = Link.extend({
  inclusive() {
    return false;
  },
}).configure({ openOnClick: false });
