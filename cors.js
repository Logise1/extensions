// Name: Free Cors Proxy
// ID: freeCorsProxy
// Description: Bypass CORS restrictions and make HTTP requests seamlessly.
// By: Logise <https://logise1123.github.io>
// License: MIT

(function (Scratch) {
  "use strict";

  const Cast = Scratch.Cast;

  class FreeCorsProxyExt {
    constructor() {
      // Default Worker URL
      this.proxyUrl = "https://corsproxy.logise1123.workers.dev";
      // Storage for custom headers
      this.customHeaders = {};
      // Cache for the last request metadata
      this.lastStatus = 0;
      this.lastStatusText = "OK";
    }

    getInfo() {
      return {
        id: "freeCorsProxy",
        name: "Free Cors Proxy",
        color1: "#4C97FF", // Blue network color
        color2: "#3373CC",
        blocks: [
          // --- Configuration ---
          {
            opcode: "setProxyUrl",
            blockType: Scratch.BlockType.COMMAND,
            text: "set CORS proxy URL to [URL]",
            arguments: {
              URL: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "https://corsproxy.logise1123.workers.dev",
              },
            },
          },
          {
            opcode: "getProxyUrl",
            blockType: Scratch.BlockType.REPORTER,
            text: "current proxy URL",
          },
          
          "---", // --- Header Management ---
          
          {
            opcode: "addHeader",
            blockType: Scratch.BlockType.COMMAND,
            text: "set request header [KEY] to [VALUE]",
            arguments: {
              KEY: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "Authorization",
              },
              VALUE: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "Bearer token123",
              },
            },
          },
          {
            opcode: "clearHeaders",
            blockType: Scratch.BlockType.COMMAND,
            text: "clear all custom headers",
          },

          "---", // --- HTTP Requests ---
          
          {
            opcode: "fetchGet",
            blockType: Scratch.BlockType.REPORTER,
            text: "send GET request to [URL]",
            arguments: {
              URL: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "https://api.ipify.org?format=json",
              },
            },
          },
          {
            opcode: "fetchCustom",
            blockType: Scratch.BlockType.REPORTER,
            text: "send [METHOD] request to [URL] with body [BODY]",
            arguments: {
              METHOD: {
                type: Scratch.ArgumentType.STRING,
                menu: "httpMethods",
                defaultValue: "POST",
              },
              URL: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "https://httpbin.org/post",
              },
              BODY: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: '{"status": "success"}',
              },
            },
          },

          "---", // --- Response Analytics ---
          
          {
            opcode: "getLastStatus",
            blockType: Scratch.BlockType.REPORTER,
            text: "last response status code",
          },
          {
            opcode: "getLastStatusText",
            blockType: Scratch.BlockType.REPORTER,
            text: "last response status text",
          },
          {
            opcode: "isLastRequestSuccess",
            blockType: Scratch.BlockType.BOOLEAN,
            text: "was last request successful?",
          },
        ],
        menus: {
          httpMethods: {
            acceptReporters: true,
            items: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
          },
        },
      };
    }

    setProxyUrl(args) {
      let url = Cast.toString(args.URL).trim();
      if (url.endsWith("/")) {
        url = url.slice(0, -1);
      }
      this.proxyUrl = url;
    }

    getProxyUrl() {
      return this.proxyUrl;
    }

    addHeader(args) {
      const key = Cast.toString(args.KEY).trim();
      const value = Cast.toString(args.VALUE);
      if (key) {
        this.customHeaders[key] = value;
      }
    }

    clearHeaders() {
      this.customHeaders = {};
    }

    getLastStatus() {
      return this.lastStatus;
    }

    getLastStatusText() {
      return this.lastStatusText;
    }

    isLastRequestSuccess() {
      return this.lastStatus >= 200 && this.lastStatus < 300;
    }

    async fetchGet(args) {
      const targetUrl = Cast.toString(args.URL);
      if (!targetUrl) return "";

      try {
        const finalUrl = `${this.proxyUrl}/?url=${encodeURIComponent(targetUrl)}`;
        
        const options = { 
          method: "GET",
          headers: { ...this.customHeaders }
        };

        const response = await Scratch.fetch(finalUrl, options);
        
        this.lastStatus = response.status;
        this.lastStatusText = response.statusText;
        
        return await response.text();
      } catch (error) {
        console.error("CORS Proxy GET Error:", error);
        this.lastStatus = 500;
        this.lastStatusText = error.message;
        return `Error: ${error.message}`;
      }
    }

    async fetchCustom(args) {
      const method = Cast.toString(args.METHOD).toUpperCase();
      const targetUrl = Cast.toString(args.URL);
      const bodyContent = Cast.toString(args.BODY);

      if (!targetUrl) return "";

      try {
        const finalUrl = `${this.proxyUrl}/?url=${encodeURIComponent(targetUrl)}`;
        
        // Setup headers dynamically, making sure Content-Type is default if missing
        const headers = { ...this.customHeaders };
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }

        const options = {
          method: method,
          headers: headers
        };

        if (method !== "GET" && method !== "HEAD" && bodyContent) {
          options.body = bodyContent;
        }

        const response = await Scratch.fetch(finalUrl, options);
        
        this.lastStatus = response.status;
        this.lastStatusText = response.statusText;
        
        return await response.text();
      } catch (error) {
        console.error(`CORS Proxy ${method} Error:`, error);
        this.lastStatus = 500;
        this.lastStatusText = error.message;
        return `Error: ${error.message}`;
      }
    }
  }

  Scratch.extensions.register(new FreeCorsProxyExt());
})(Scratch);
