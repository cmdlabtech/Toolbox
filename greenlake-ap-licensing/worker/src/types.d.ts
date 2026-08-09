// report-template.html is imported as a string (wrangler Text module rule).
declare module "*.html" {
  const content: string;
  export default content;
}
