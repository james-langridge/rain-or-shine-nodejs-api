import YAML from "yaml";
import fs from "fs";
import path from "path";
import { config } from "./environment";

const openApiPath = path.join(__dirname, "../docs/openapi.yml");
const openApiFile = fs.readFileSync(openApiPath, "utf8");
const openApiSpec = YAML.parse(openApiFile);

openApiSpec.servers = [
  {
    url: config.APP_URL || "http://localhost:3001",
    description: config.isProduction
      ? "Production server"
      : "Development server",
  },
];

export const swaggerSpec = openApiSpec;
