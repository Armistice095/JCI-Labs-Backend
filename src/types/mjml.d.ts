declare module 'mjml' {
  const mjml2html: (input: string, options?: Record<string, unknown>) => { html: string; errors: { message: string }[] };
  export default mjml2html;
}
