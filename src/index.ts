import blessed from "blessed";
import cp from "child_process";
import { mkdirSync } from "fs";
import { symlinkSync } from "fs";
import { existsSync, linkSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { userInfo } from "os";
import YAML from "yaml";

// Initialize config
const user = userInfo();
if (user.username !== "root") {
  console.error("You must run this program as root");
  process.exit(1);
}

if (!existsSync(`${user.homedir}/.ngx`)) mkdirSync(`${user.homedir}/.config/ngx`, { recursive: true });
class Config {
  nginxPath: string;
  sitesAvailable: string;
  sitesEnabled: string;
  defaultVhosts: string;
}

const config = new Config();
const configPath = `${user.homedir}/.ngx/ngx.yaml`;

try {
  refreshConfig();
} catch (error: any) {
  console.error("Error reading config file: " + error.message);
  console.error(configPath);
  process.exit(1);
}

function refreshConfig() {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, YAML.stringify({
      nginxPath: "/etc/nginx",
      sitesAvailable: "/etc/nginx/sites-available",
      sitesEnabled: "/etc/nginx/sites-enabled",
      defaultVhosts: "/var/www/html",
    }));
  }
  const yamlConfig = YAML.parse(readFileSync(configPath, "utf8"));
  Object.assign(config, yamlConfig);
  
  config.nginxPath ||= "/etc/nginx";
  config.sitesAvailable ||= `${config.nginxPath}/sites-available`;
  config.sitesEnabled ||= `${config.nginxPath}/sites-enabled`;
  config.defaultVhosts ||= `/var/www/html`;
}

class NginxServer {
  name: string;
  hosts: string[];
  port: number[];
  root: string;
  enabled: boolean;

  getContent() {
    return readFileSync(`${config.sitesAvailable}/${this.name}`, "utf8");
  }

  constructor(name: string) {
    this.name = name;
    this.reload();
  }

  public static reloadNginx() {
    cp.execSync("systemctl reload nginx");
  }

  public static restartNginx() {
    cp.execSync("systemctl restart nginx");
  }

  reload() {
    const content = readFileSync(`${config.sitesAvailable}/${this.name}`, "utf8");

    const host = (content.match(/server_name\s+(.+);/)?.slice(1)[0] || "").split(" ");
    const _p = Array.from(content.matchAll(/\s*listen\s+(\d+)/g)).map(m => +m[1]).filter(a => !isNaN(a));
    const port = _p || [];
    const root = content.match(/root\s+(.+);/)?.slice(1)[0] || "";
    const enabled = existsSync(`${config.sitesEnabled}/${this.name}`);

    this.hosts = host;
    this.port = port;
    this.root = root;
    this.enabled = enabled;
  }

  enable() {
    if (this.enabled) {
      return;
    }
    symlinkSync(`${config.sitesAvailable}/${this.name}`, `${config.sitesEnabled}/${this.name}`);
    this.enabled = true;
  }

  disable() {
    if (!this.enabled) {
      return;
    }
    rmSync(`${config.sitesEnabled}/${this.name}`);
    this.enabled = false;
  }

  toggle() {
    if (this.enabled) {
      this.disable();
    } else {
      this.enable();
    }
  }
};
const nginxServers: NginxServer[] = [];

function createNginxServer(name: string) {
  return new NginxServer(name);
}

function loadNginxServers() {
  nginxServers.length = 0;
  const files = readdirSync(config.sitesAvailable);
  nginxServers.push(...files.map(createNginxServer));
}

try {
  loadNginxServers();
} catch (error: any) {
  console.error("Error loading nginx servers: " + error.message);
  process.exit(1);
}


// Initialize UI
const screen = blessed.screen({
  smartCSR: true,
  title: "NGX",
  debug: true
});

screen.key(["escape", "q", "C-c"], () => process.exit(0));

const header = blessed.box({
  parent: screen,
  padding: { left: 1, right: 1 },
  top: 0,
  left: 0,
  width: "100%",
  height: 4,
  border: {
    type: "line"
  },
  style: {
    border: {
      fg: "blue"
    }
  },
  content: "NGINX Servers"
});

const newSiteButton = blessed.button({
  parent: header,
  mouse: true,
  keys: true,
  shrink: true,
  left: 0,
  bottom: 0,
  padding: { left: 1, right: 1 },
  content: "New Site",
  style: {
    bg: "green",
    fg: "white",
    hover: {
      bg: "blue"
    }
  }
});

const editConfigButton = blessed.button({
  parent: header,
  mouse: true,
  keys: true,
  shrink: true,
  left: 10,
  bottom: 0,
  padding: { left: 1, right: 1 },
  content: "Edit Config",
  style: {
    bg: "green",
    fg: "white",
    hover: {
      bg: "blue"
    }
  }
});

editConfigButton.on("press", async () => {
  const initialContent = readFileSync(configPath, "utf8");
  const { file, data } = await tempEditor({
    extension: "yaml",
    content: initialContent
  });

  if (data !== initialContent) {
    try {
      writeFileSync(configPath, data);
      refreshConfig();
      footer.setContent("Config updated");

      loadNginxServers();
      serverList.setItems(nginxServers.map(server => server.name));
      serverList.select(0);
      serverList.focus();
      if (nginxServers.length > 0) {
        setDetails(nginxServers[0]);
      }
      else {
        setDetails(null);
      }
    } catch (error: any) {
      writeFileSync(configPath, initialContent);
      footer.setContent("Undid changeds - Config update failed: " + error.message);
    }
  }
  else {
    footer.setContent("Config unchanged");
  }
  screen.render();
});

async function tempEditor(options?: {
  extension?: string,
  content?: string,
}) {
  options ??= {};
  const tmpName = `/tmp/${Date.now()}.${options?.extension ? "tmp." + options?.extension : "tmp"}`;
  writeFileSync(tmpName, options?.content ?? "");
  const promise = new Promise<{
    file: string,
    data: string,
  }>((resolve, reject) => {
    screen.exec(process.env["EDITOR"] ?? "vim", [tmpName], {}, (err) => {
      if (err) {
        reject(err);
      }


      resolve({
        file: tmpName,
        data: readFileSync(tmpName, "utf8")
      });
      rmSync(tmpName);
    });
  });

  return promise;
}

let lastFailedNewSiteContent: string = null;
newSiteButton.on("press", async () => {
  const initialContent = lastFailedNewSiteContent ?? [
    "### Required fields",
    `# Site name`,
    `name: `,
    ``,
    `# Server hostname (etc: example.com www.example.com)`,
    `host: `,
    ``,
    `# Port to listen on`,
    `port: 80`,
    ``,
    `# Root directory ({name}, {host} will be replaced with site name and host respectively)`,
    `root: ${config.defaultVhosts}/{name}`,
    ``,
    ``,
    `### Optional fields`,
    `# Index file (Default: index.html - PHP default: index.php))`,
    `index: `,
    ``,
    `# PHP version (php7.4, php8.0)`,
    `php: `,
    ``,
    `# Proxy URL (http://localhost:8080)`,
    `proxyUrl: `,
    ``,
  ].join("\n");
  const eData = await tempEditor({
    content: initialContent,
    extension: "yaml"
  });

  if (eData.data.trim() === initialContent.trim()) {
    footer.setContent(`No changes made, aborting`);
    screen.render();
    return;
  }


  try {
    const data = YAML.parse(eData.data);

    if (!data.name || !data.host || !data.port || !data.root) {
      throw new Error("Missing one or more required fields");
    }

    if (existsSync(`${config.sitesAvailable}/${data.name}`)) {
      throw new Error("Site already exists");
    }

    data.root = data.root.replace(/\{name\}/g, data.name).replace(/\{host\}/g, data.host);
    data.root = data.root.replace(/\s/g, "_");

    if (existsSync(data.root)) {
      data.root = `${data.root}/${data.name}`;
    }

    data.index = data.index?.trim() || (data.php ? "index.php" : "index.html")

    mkdirSync(data.root, { recursive: true });
    writeFileSync(`${data.root}/${data.index}`, [
      `<!DOCTYPE html>`,
      `<html>`,
      `<head>`,
      `  <title>${data.name}</title>`,
      `</head>`,
      `<body>`,
      `  <h1>${data.name}</h1>`,
      `</body>`,
      `</html>`,
      data.php && data.index.endsWith(".php") ? (
        `<?php phpinfo(); ?>`
      ) : "",
    ].join("\n"));

    writeFileSync(`${config.sitesAvailable}/${data.name}`, [
      `server {`,
      `  listen ${data.port};`,
      `  server_name ${data.host};`,
      `  root ${data.root};`,
      `  index ${data.index};`,
      ``,
      `  location / {`,
      `    try_files $uri $uri/ =404;`,
      `  }`,
      ``,
      data.proxyUrl ? (
        [
          `  location / {`,
          `    proxy_set_header X-Forwarded-For $remote_addr;`,
          `    proxy_set_header Host $http_host;`,
          `    proxy_set_header Upgrade $http_upgrade;`,
          `    proxy_set_header Connection "upgrade";`,
          `    proxy_pass       ${data.proxyUrl};`,
          `  }`,
          ``,
        ].join("\n")
      ) : null,
      data.php ? (
        [
          `  location ~ \\.php {`,
          `    fastcgi_pass unix:/run/php/${data.php}-fpm.sock;`,
          `    fastcgi_split_path_info ^((?U).+\\.php)(/?.+)$;`,
          `    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;`,
          `    fastcgi_param PATH_INFO $fastcgi_path_info;`,
          `    fastcgi_param PATH_TRANSLATED $document_root$fastcgi_path_info;`,
          `    fastcgi_read_timeout 600s;`,
          `    fastcgi_send_timeout 600s;`,
          `    fastcgi_index ${data.index.endsWith(".php") ? data.index : "index.php"};`,
          `    include /etc/nginx/fastcgi_params;`,
          `  }`,
          ``,
        ].join("\n")
      ) : null,
      `}`
    ].filter(a => a !== null).join("\n"));


    nginxServers.push(createNginxServer(data.name));
    nginxServers.sort((a, b) => a.name.localeCompare(b.name));
    nginxServers.sort((a, b) => a.enabled ? -1 : 1);
    serverList.setItems(nginxServersToItems());

    lastFailedNewSiteContent = null;

    screen.render();
  } catch (error: any) {
    lastFailedNewSiteContent = eData.data;
    footer.setContent(`Error: ${error.message}. Draft saved. Click "New site" to edit it again.`);
    screen.render();
  }
});

function nginxServersToItems() {
  // Green color block on the left of the selected item if enabled, otherwise red
  return nginxServers.map(server => `${server.enabled ? "\x1b[42m" : "\x1b[41m"}  \x1b[0m ${server.name}`);
}

// List of NGINX servers
const serverList = blessed.list({
  parent: screen,
  padding: { left: 1, right: 1 },
  mouse: true,
  keys: true,
  top: 4,
  left: 0,
  width: "50%",
  height: "100%-7",
  border: {
    type: "line"
  },
  style: {
    border: {
      fg: "blue"
    },
    selected: {
      bg: "blue",
      fg: "white"
    },
    item: {
      hover: {
        bg: "gray",
        fg: "white"
      },
    },
    focus: {
      border: {
        fg: "blue"
      }
    }
  },
  items: nginxServersToItems(),
  content: nginxServers.length ? null : "No servers found",
});

// Server details
const details = blessed.scrollablebox({
  parent: screen,
  padding: { left: 1, right: 1 },
  top: 4,
  right: 0,
  width: "50%",
  height: "100%-7",
  border: {
    type: "line"
  },
  style: {
    border: {
      fg: "blue"
    }
  },
  content: "No server selected"
});

serverList.on("select item", (item, index) => setDetails(nginxServers[index]));

function setDetails(server: NginxServer) {
  if (!server) {
    details.setContent("No server selected");
    screen.render();
    return;
  }
  details.setContent([
    `Status: ${server.enabled ? "\x1b[42m Enabled" : "\x1b[41m Disabled"} \x1b[0m`,
    `Name: ${server.name}`,
    `Host: ${server.hosts}`,
    `Port: ${server.port}`,
    `Root: ${server.root}`,
  ].join("\n"));

  const detailsEdit = blessed.button({
    parent: details,
    mouse: true,
    keys: true,
    shrink: true,
    left: 0,
    bottom: 0,
    padding: { left: 1, right: 1 },
    content: "Edit",
    style: {
      bg: "blue",
      fg: "white",
      hover: {
        bg: "green"
      }
    }
  });

  detailsEdit.on("press", () => {
    const data = server.getContent();

    tempEditor({
      content: data,
      extension: "conf"
    }).then((eData) => {
      if (eData.data === data) {
        footer.setContent("No changes made");
        screen.render();
        return;
      }
      try {
        writeFileSync(`${config.sitesAvailable}/${server.name}`, eData.data);
        server.reload();
        setDetails(server);
      } catch (error: any) {
        footer.setContent(`Error: ${error.message}`);
        screen.render();
      }
    });
  });

  const detailsToggle = blessed.button({
    parent: details,
    mouse: true,
    keys: true,
    shrink: true,
    left: 8,
    width: 9,
    bottom: 0,
    padding: { left: 1, right: 1 },
    content: server.enabled ? "Disable" : "Enable",
    style: {
      bg: server.enabled ? "red" : "green",
      fg: "white",
      hover: {
        bg: "blue"
      }
    }
  });

  detailsToggle.on("press", () => {
    server.toggle();
    serverList.setItems(nginxServersToItems());
    setDetails(server);
  });

  screen.render();
}

if (nginxServers.length > 0) {
  setDetails(nginxServers[0]);
}

const footer = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 3,
  border: {
    type: "line"
  },
  style: {
    border: {
      fg: "red"
    }
  },
});

screen.render();