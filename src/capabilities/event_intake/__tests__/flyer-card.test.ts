import { describe, test, expect } from "vitest";
import {
   renderFlyerRequestCard,
   renderTicketFlyerNotice,
   renderAgitpropFlyerNotice,
} from "../flyer-card.js";

const PARSED = {
   title: "Círculo de lectura",
   dayRaw: "domingo",
   timeRaw: "8pm",
   speaker: "Burbuja",
   flyerSelf: false,
   pairs: [],
};

describe("renderFlyerRequestCard", () => {
   test("requested card includes brief and delivery instructions", () => {
      const card = renderFlyerRequestCard({
         ticketChannelId: "ticket-1",
         requesterId: "user-1",
         parsed: PARSED,
         status: "requested",
      });
      expect(card).toContain("Solicitud de flyer");
      expect(card).toContain("Círculo de lectura");
      expect(card).toContain("<#ticket-1>");
      expect(card).toContain("<@user-1>");
      expect(card).toContain("responde **a este mensaje**");
      expect(card).toContain("no** hará su propio flyer");
   });

   test("cancelled card is struck through", () => {
      const card = renderFlyerRequestCard({
         ticketChannelId: "ticket-1",
         requesterId: null,
         parsed: PARSED,
         status: "cancelled",
      });
      expect(card).toContain("~~");
      expect(card).toContain("CANCELADA");
   });

   test("delivered card confirms completion", () => {
      const card = renderFlyerRequestCard({
         ticketChannelId: "ticket-1",
         requesterId: "user-1",
         parsed: PARSED,
         status: "delivered",
      });
      expect(card).toContain("Flyer entregado");
      expect(card).not.toContain("responde **a este mensaje**");
   });
});

describe("flyer notices", () => {
   test("ticket notices cover all transitions", () => {
      expect(renderTicketFlyerNotice("opened")).toContain("Agitprop");
      expect(renderTicketFlyerNotice("open_failed")).toContain("No pude abrir");
      expect(renderTicketFlyerNotice("edited")).toContain("Actualicé");
      expect(renderTicketFlyerNotice("cancelled")).toContain("Cancelé");
      expect(renderTicketFlyerNotice("delivered")).toContain(
         "Agitprop entregó",
      );
      expect(renderTicketFlyerNotice("delivered_in_ticket")).toContain(
         "se subió aquí",
      );
      expect(renderTicketFlyerNotice("delivered_in_ticket")).not.toContain(
         "Agitprop entregó",
      );
   });

   test("agitprop notices reference the ticket channel", () => {
      expect(renderAgitpropFlyerNotice("ticket-1", "cancelled")).toContain(
         "<#ticket-1>",
      );
      expect(renderAgitpropFlyerNotice("ticket-1", "edited")).toContain(
         "<#ticket-1>",
      );
      expect(
         renderAgitpropFlyerNotice("ticket-1", "delivered_in_ticket"),
      ).toContain("<#ticket-1>");
   });
});
