# LingoStack Public Release Analysis

## Modules

| Module | Input | Output | Dependency |
| --- | --- | --- |
| Repository metadata | Current private repository | Public `LingoStack` repository | GitHub owner permission |
| README | Existing Chinese technical README | Bilingual public README | Release scope contract |
| Release package | Existing extension packaging script | Extension-only archive | Manifest and package validation |

## Integration Chain

```text
release scope contract
        |
        +--> README.md
        |
        +--> package inspection
        |
        +--> GitHub repository rename and public visibility
```

`README.md` must be committed before the GitHub setting change. The final verification checks the remote repository, the resulting default URL and the public archive.

## Risk

Making the repository public makes all reachable Git history public. A tracked-files credential scan cannot prove that historical commits contain no secrets. The delivery must scan tracked content and recent reachable history for common credential patterns, then report the residual limitation without exposing any matched values.

