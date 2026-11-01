# Credits and project lineage

## git-flode

[git-flode](https://github.com/tima-fey/git-flode) is an independent fork
maintained in the `tima-fey/git-flode` repository. Its additions cover configuration
files in Git, editing existing YAML automations, Git controls, HA maintenance
controls, object snapshots, and project reference tests.

## Upstream FLODE

The visual editor, graph model, Lit panel, native Home Assistant editor
integration, parser/transpiler work, and much of the existing test suite come
from [FLODE](https://github.com/SH1FT-W/flode) by
[SH1FT-W](https://github.com/SH1FT-W) and its contributors. The fork retains the
upstream package names and `flode` integration domain.

The following acknowledgements are preserved from the upstream README. They
describe contributions to upstream FLODE, rather than claims about participation
in this fork:

- [**@bartbutenaers**](https://github.com/bartbutenaers): the most reports of all, from wires and branch dragging to touch and context menus, always with precise steps.
- [**@Hedda**](https://github.com/Hedda): the push to English as the main language, the Lit rebuild and the labels like Home Assistant.
- [**@srsly88**](https://github.com/srsly88): nested AND/OR conditions, the save dialog and the sidebar editor.
- [**@jlpnea**](https://github.com/jlpnea): `choose` blocks that render all the way down and `script.stop`.
- [**@NullScope**](https://github.com/NullScope), [**@pkejval**](https://github.com/pkejval): parallel steps after `scene.create` and the vertical flow.
- [**@Home-Wizz**](https://github.com/Home-Wizz), [**@JoHeyr**](https://github.com/JoHeyr), [**@oscarallo**](https://github.com/oscarallo), [**@HL-Apprentice**](https://github.com/HL-Apprentice), [**@DeKaN**](https://github.com/DeKaN), [**@Daniel-wendan**](https://github.com/Daniel-wendan), [**@bramcardon-alt**](https://github.com/bramcardon-alt), [**@dgarrison63**](https://github.com/dgarrison63): reports and ideas that made it into FLODE.

## C.A.F.E.

FLODE itself originated as a fork of
[C.A.F.E. (Complex Automation Flow Editor)](https://github.com/FezVrasta/cafe-hass)
by [Federico Zivolo](https://github.com/FezVrasta). The parser, transpiler, and
state machine strategy carry that lineage; historical `CafeMetadata` names
and C.A.F.E. fixtures remain in the codebase.

## License and historical material

The project is licensed under [Apache 2.0](LICENSE). Existing copyright notices
and the license text are retained. Entries under **Upstream FLODE history** in
[CHANGELOG.md](CHANGELOG.md) describe the original project; their issue links
continue to point to upstream for historical attribution.

Report fork-specific issues to
[git-flode](https://github.com/tima-fey/git-flode/issues). Upstream FLODE and
C.A.F.E. are separate projects. git-flode is not affiliated with Home Assistant
or Nabu Casa.
