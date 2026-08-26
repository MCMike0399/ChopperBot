import { describe, test, expect } from "vitest";
import {
   renderHowToBlock,
   type HowToChannelFact,
} from "../howto.js";

const FACTS: HowToChannelFact[] = [
   {
      id: "1525358955751276544",
      name: "📋│formulario-circulos",
      role: "proponer_circulo",
      topic: null,
   },
   {
      id: "1436255397265670195",
      name: "📮│ticket",
      role: "ticket",
      topic:
         "En este canal podrás ponerte en contacto con lxs moderadorxs para hacer una denuncia o para problemas técnicos.",
   },
];

describe("renderHowToBlock", () => {
   test("opens with the attending rule so a 0-tool-call reply cannot invent a reservation", () => {
      const block = renderHowToBlock(FACTS);
      expect(block).toContain("Asistir a un evento es abierto y gratis");
      expect(block).toMatch(/no hay reserva/i);
      expect(block).toContain("dónde reservo");
      expect(block).toContain("no hace falta");
   });

   test("uses the live ticket topic and never treats ticket as the event door", () => {
      const block = renderHowToBlock(FACTS);
      expect(block).toContain("denuncia");
      expect(block).toContain("<#1436255397265670195>");
      expect(block).toContain("NUNCA eventos");
      expect(block).toContain("<#1525358955751276544>");
      expect(block).toContain("Proponer un círculo");
   });

   test("falls back when a channel has no topic", () => {
      const block = renderHowToBlock(FACTS);
      expect(block).toContain("Formulario para proponer un círculo");
   });
});
