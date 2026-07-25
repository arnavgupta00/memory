declare module "cytoscape-elk" {
  const extension: (cytoscape: typeof import("cytoscape")) => void;
  export default extension;
}

declare module "cytoscape-fcose" {
  const extension: (cytoscape: typeof import("cytoscape")) => void;
  export default extension;
}
