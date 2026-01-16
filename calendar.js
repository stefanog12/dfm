import { google } from "googleapis";

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

const WORKING_HOURS = {
  start: 9,
  end: 18,
  lunchStart: 13,
  lunchEnd: 14,
};

const SLOT_DURATION_MINUTES = 120;

function getCalendarClient(fastify) {
  const authClient = fastify.getAuthorizedClient();
  if (!authClient) {
    throw new Error("Google Calendar non è collegato. Vai su /auth/google per collegarlo.");
  }
  return google.calendar({ version: "v3", auth: authClient });
}

function isWorkingHours(date) {
  const hour = date.getHours();
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  if (hour < WORKING_HOURS.start || hour >= WORKING_HOURS.end) return false;
  if (hour >= WORKING_HOURS.lunchStart && hour < WORKING_HOURS.lunchEnd) return false;
  return true;
}

export async function getAvailableSlots(fastify, startDate, endDate) {
  const calendar = getCalendarClient(fastify);

  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: startDate.toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = response.data.items || [];
  const availableSlots = [];

  let currentDate = new Date(startDate);

  while (currentDate < endDate) {
    if (isWorkingHours(currentDate)) {
      const slotEnd = new Date(currentDate.getTime() + SLOT_DURATION_MINUTES * 60000);

      const isSlotFree = !events.some((event) => {
        const eventStart = new Date(event.start.dateTime || event.start.date);
        const eventEnd = new Date(event.end.dateTime || event.end.date);
        return currentDate < eventEnd && slotEnd > eventStart;
      });

      if (isSlotFree && slotEnd.getHours() <= WORKING_HOURS.end) {
        availableSlots.push({
          start: new Date(currentDate),
          end: new Date(slotEnd),
          date: currentDate.toLocaleDateString("it-IT"),
          time: currentDate.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
        });
      }
    }

    currentDate = new Date(currentDate.getTime() + 30 * 60000);
  }

  return availableSlots;
}

export async function findFirstAvailableSlot(fastify) {
  const now = new Date();
  const twoWeeksLater = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const slots = await getAvailableSlots(fastify, now, twoWeeksLater);
  if (slots.length === 0) return null;
  return slots[0];
}

export async function findSlotsInWeek(fastify, weekOffset = 0) {
  const now = new Date();
  const currentDay = now.getDay();
  const daysToMonday = currentDay === 0 ? -6 : 1 - currentDay;
  const monday = new Date(now);
  monday.setDate(now.getDate() + daysToMonday + weekOffset * 7);
  monday.setHours(0, 0, 0, 0);

  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  friday.setHours(23, 59, 59, 999);

  const slots = await getAvailableSlots(fastify, monday, friday);

  return {
    week: `${monday.toLocaleDateString("it-IT")} - ${friday.toLocaleDateString("it-IT")}`,
    slots,
    morning: slots.filter((s) => s.start.getHours() < WORKING_HOURS.lunchStart),
    afternoon: slots.filter((s) => s.start.getHours() >= WORKING_HOURS.lunchEnd),
  };
}

export async function findFirstDayWithSlot(fastify, period = "any", weekOffset = 0) {
  const weekData = await findSlotsInWeek(fastify, weekOffset);

  let slotsToCheck = weekData.slots;
  if (period === "morning") slotsToCheck = weekData.morning;
  else if (period === "afternoon") slotsToCheck = weekData.afternoon;

  if (slotsToCheck.length === 0) return null;

  const slotsByDay = {};
  slotsToCheck.forEach((slot) => {
    const day = slot.date;
    if (!slotsByDay[day]) slotsByDay[day] = [];
    slotsByDay[day].push(slot);
  });

  const firstDay = Object.keys(slotsByDay)[0];
  return {
    date: firstDay,
    slots: slotsByDay[firstDay],
  };
}

export async function createAppointment(fastify, startDateTime, customerName, customerPhone, description) {
  const calendar = getCalendarClient(fastify);
  const endDateTime = new Date(startDateTime.getTime() + SLOT_DURATION_MINUTES * 60000);

  const event = {
    summary: `Intervento - ${customerName}`,
    description: `Cliente: ${customerName}\nTelefono: ${customerPhone}\nNote: ${description}`,
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: "Europe/Rome",
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: "Europe/Rome",
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "email", minutes: 24 * 60 },
        { method: "popup", minutes: 60 },
      ],
    },
  };

  const response = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: event,
  });

  return {
    success: true,
    eventId: response.data.id,
    htmlLink: response.data.htmlLink,
    slot: {
      date: startDateTime.toLocaleDateString("it-IT"),
      time: startDateTime.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
    },
  };
}

export async function parseSchedulingRequest(fastify, userRequest) {
  const request = userRequest.toLowerCase();

  if (request.includes("primo") && (request.includes("disponibile") || request.includes("libero"))) {
    const slot = await findFirstAvailableSlot(fastify);
    if (!slot) {
      return { type: "no_slots", message: "Non ci sono slot disponibili nelle prossime 2 settimane." };
    }
    return {
      type: "first_available",
      slot,
      message: `Il primo slot disponibile è ${slot.date} alle ore ${slot.time}`,
    };
  }

  let weekOffset = 0;
  if (request.includes("prossima settimana") || request.includes("settimana prossima")) {
    weekOffset = 1;
  } else if (request.includes("questa settimana")) {
    weekOffset = 0;
  }

  let period = "any";
  if (request.includes("pomeriggio")) period = "afternoon";
  else if (request.includes("mattina") || request.includes("mattino")) period = "morning";

  const dayData = await findFirstDayWithSlot(fastify, period, weekOffset);

  if (!dayData) {
    return {
      type: "no_slots",
      message: `Non ci sono slot disponibili ${
        period === "morning" ? "la mattina" : period === "afternoon" ? "il pomeriggio" : ""
      } ${weekOffset === 1 ? "la prossima settimana" : "questa settimana"}.`,
    };
  }

  return {
    type: "slots_found",
    date: dayData.date,
    slots: dayData.slots,
    message: `${weekOffset === 1 ? "La prossima settimana" : "Questa settimana"}, il primo giorno ${
      period === "morning" ? "con slot la mattina" : period === "afternoon" ? "con slot il pomeriggio" : "disponibile"
    } è ${dayData.date}. Slot disponibili: ${dayData.slots.map((s) => s.time).join(", ")}`,
  };
}
