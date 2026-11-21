import matter from "gray-matter"

// Parse front matter through the same gray-matter and js-yaml the probe's config path loads; no network or tools.
console.log(JSON.stringify(matter("---\nname: probe\n---\nbody").data))
