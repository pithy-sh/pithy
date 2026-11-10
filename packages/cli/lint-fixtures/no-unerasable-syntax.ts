// Matched: an enum, a const enum, a namespace, a dotted namespace, a legacy module, each modifier a parameter
// property takes, an abstract class's, an import equals declaration in each form, an angle-bracket type assertion.
// An export assignment is matched too; it cannot share a module with other exports, so it has its own fixture,
// `export-assignment.ts`.
export enum Color {
  Red,
}
const enum Size {
  Small,
}
export namespace Values {
  export const one = 1;
}
namespace Types {
  export type T = 1;
}
namespace Outer.Inner {
  export const two = 2;
}
module Legacy {}
class Fields {
  constructor(
    private a: number,
    public b: number,
    protected c: number,
    readonly d: number,
    private readonly e: number,
  ) {}
}
class Child extends Fields {
  constructor(override a: number) {
    super(a, 1, 1, 1, 1);
  }
}
abstract class Shape {
  constructor(protected side: number) {}
}
import os = require("node:os");
export import path = require("node:path");
import release = os.release;
const size = <number>(1 as unknown);
const nested = (<string>(<unknown>"a")).length;
// Not matched: anything ambient, a plain parameter, a field assigned in the constructor, an object as const.
declare enum Ambient {
  A,
}
declare const enum AmbientConst {
  A,
}
export declare enum ExportedAmbient {
  A,
}
declare namespace Global {
  const a: 1;
}
export declare namespace Exported {
  const a: 1;
}
declare module "virtual" {
  import os = require("node:os");
  const c: 3;
  export = c;
  namespace Inside {
    const b: 2;
  }
  enum InsideEnum {
    A,
  }
}
import type url = require("node:url");
declare global {
  interface Window {}
}
declare class Declared {
  constructor(a: number);
}
class Plain {
  readonly a: number;
  constructor(a: number) {
    this.a = a;
  }
}
const Direction = { Up: "up", Down: "down" } as const;
const width = 1 as unknown as number;
