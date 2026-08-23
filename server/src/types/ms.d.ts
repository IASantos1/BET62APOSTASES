declare module "ms" {
  function ms(val: string, options?: { long?: boolean }): number;
  function ms(val: number, options?: { long?: boolean }): string;
  export default ms;
}
