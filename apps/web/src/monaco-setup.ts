import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// paths look wrong but monaco's exports map rewrites "monaco-editor/x" to
// "./esm/vs/x.js"
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";

// @monaco-editor/react grabs monaco off jsdelivr by default. can't have that --
// if a CDN can swap our JS it can serve a build that copies the plaintext
// before encrypting, and the whole E2E claim falls apart.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });
