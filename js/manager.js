import { createWorkflowSwitchers } from "./workflow-switchers.js";
import { app as app } from "../../../scripts/app.js";
import { api as api } from "../../../scripts/api.js";
import { sendMsg, addListener } from "./connection.js";
import { photoshopNode } from "./nodestyle.js";

export const nodever = "1.9.3";
const switchers = createWorkflowSwitchers({
  graph: () => app.graph,
  send: sendMsg,
  redraw: () => app.graph?.setDirtyCanvas(true, true),
});
addListener("photoshopConnected", () => switchers.refresh(true));
addListener("workflow", id => switchers.toggle("workflow", id));
addListener("rndrMode", id => switchers.toggle("rndrMode", id));
setInterval(() => switchers.refresh(), 500);

addListener("alert", (data) => {
  try {
    alert(data);
  } catch (error) {
    console.error("🔹 Error in alert listener:", error);
  }
});

addListener("queue", async () => {
  if (isProcessing || !photoshopNode.length) return;
  isProcessing = true;
  try { await app.queuePrompt(0, 1); }
  catch (error) { sendMsg("alert", "Workflow submit failed: " + error); }
  finally { isProcessing = false; }
});

// Register extension with ComfyUI
app.registerExtension({
  name: "PhotoshopToComfyUINode",
  async beforeRegisterNodeDef(nodeType, nodeInfo, appInstance) {
    if (nodeInfo.category === "Photoshop") {
      appendMenuOption(nodeType, (_, menuOptions) => {
        menuOptions.unshift({
          content: "🔹 Install PS Plugin V" + nodever,
          callback: () => sendMsg("install_plugin"),
        });
      });
    }
  },

  onProgressUpdate(event) {
    try {
      if (!this.connected) return;
      let prompt = event.detail.prompt;
      this.currentPromptExecution = prompt;
      if (prompt?.errorDetails) {
        let errorText = `${prompt.errorDetails?.exception_type} ${prompt.errorDetails?.node_id || ""} ${
          prompt.errorDetails?.node_type || ""
        }`;
        this.progressTextEl.innerText = errorText;
        this.progressNodesEl.classList.add("-error");
        this.progressStepsEl.classList.add("-error");
        return;
      }
    } catch (error) {
      console.error("🔹 Error in onProgressUpdate:", error);
    }
  },

  afterConfigureGraph() { switchers.invalidate(); },
  nodeCreated(node) {
    if ((node.comfyClass || node.type) !== "Fast Groups Muter (rgthree)") return;
    const original = node.getExtraMenuOptions;
    node.getExtraMenuOptions = function(canvas, options) {
      const result = original?.call(this, canvas, options);
      for (const [role, title] of [["workflow", "工作流模式"], ["rndrMode", "渲染风格"], ["none", "不作为 Photoshop 开关"], [null, "自动识别"]]) {
        options.push({content: "Photoshop：" + title, callback: () => {
          this.properties ||= {};
          if (role === null) delete this.properties.psSwitcherRole;
          else this.properties.psSwitcherRole = role;
          switchers.invalidate(); app.graph?.setDirtyCanvas(true, true);
        }});
      }
      return result;
    };
  },
});

async function getWorkflow(name) {
  try {
    console.log("name: ", name);
    const response = await api.fetchApi(`/ps/workflows/${encodeURIComponent(name)}`, { cache: "no-store" });
    console.log("response: ", response);
    return await response.json();
  } catch (error) {
    console.error("🔹 Error in getWorkflow:", error);
  }
}

export async function loadWorkflow(workflowName) {
  const supportedLocales = ["ja-JP", "ko-KR", "zh-TW", "zh-CN"];
  let currentLocale = localStorage.getItem("AGL.Locale");

  if (!supportedLocales.includes(currentLocale)) {
    currentLocale = "en-US";
  }

  console.log("🔹 Load workflow for this language:", currentLocale);
  workflowName = workflowName + "_" + currentLocale;
  try {
    const workflowData = await getWorkflow(workflowName);
    app.loadGraphData(workflowData);
  } catch (error) {
    console.error(`Failed to load workflow ${workflowName}:`, error);
    alert(`Failed to load workflow ${workflowName}`);
  }
}

let genrateStatus = "genrated";
let isProcessing = false;

api.addEventListener("execution_start", ({ detail }) => {
  try {
    genrateStatus = "genrating";
    sendMsg("render_status", "genrating");
  } catch (error) {
    console.error("🔹 Error in execution_start listener:", error);
  }
});
api.addEventListener("executing", ({ detail }) => {
  try {
    if (!detail || detail.node === null) {
      genrateStatus = "genrated";
      isProcessing = false;
      sendMsg("render_status", "genrated");
    }
  } catch (error) {
    console.error("🔹 Error in executing listener:", error);
  }
});
api.addEventListener("execution_error", ({ detail }) => {
  try {
    genrateStatus = "genrated";
    isProcessing = false;
    sendMsg("render_status", "genrate_error");
  } catch (error) {
    console.error("🔹 Error in execution_error listener:", error);
  }
});
api.addEventListener("progress", ({ detail: { value, max } }) => {
  try {
    let progress = Math.floor((value / max) * 100);
    if (!isNaN(progress) && progress >= 0 && progress <= 100) {
      sendMsg("progress", progress);
    }
  } catch (error) {
    console.error("🔹 Error in progress listener:", error);
  }
});

export function appendMenuOption(nodeType, callbackFn) {
  const originalMenuOptions = nodeType.prototype.getExtraMenuOptions;
  nodeType.prototype.getExtraMenuOptions = function () {
    const options = originalMenuOptions.apply(this, arguments);
    callbackFn.apply(this, arguments);
    return options;
  };
}
