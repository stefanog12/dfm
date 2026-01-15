import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';
import { getAuthorizedClient } from "./auth.js";

const SCOPES = ['https://www.googleapis.com/auth/calendar'];


// Orari di lavoro (modificabili)
const WORKING_HOURS = {
    start: 8,  // 8:00
    end: 17,   // 17:00
    lunchStart: 13, // 13:00
    lunchEnd: 14,   // 14:00
};

const SLOT_DURATION_MINUTES = 120; // Durata intervento: 2 ore

export async function authorize() {
  const client = getAuthorizedClient();
  if (!client) {
    throw new Error("Google Calendar non è collegato. Vai su /auth/google");
  }
  return client;
}


/**
 * Verifica se un orario è durante l'orario lavorativo
 */
function isWorkingHours(date) {
    const hour = date.getHours();
    const day = date.getDay();
    
    // Sabato e domenica
    if (day === 0 || day === 6) return false;
    
    // Fuori orario
    if (hour < WORKING_HOURS.start || hour >= WORKING_HOURS.end) return false;
    
    // Pausa pranzo
    if (hour >= WORKING_HOURS.lunchStart && hour < WORKING_HOURS.lunchEnd) return false;
    
    return true;
}

/**
 * Ottiene tutti gli slot disponibili per un range di date
 */
export async function getAvailableSlots(startDate, endDate) {
    const auth = await authorize();
    const calendar = google.calendar({ version: 'v3', auth });
    
    try {
        // Ottieni tutti gli eventi nel range
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: startDate.toISOString(),
            timeMax: endDate.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });
        
        const events = response.data.items || [];
        const availableSlots = [];
        
        // Genera tutti gli slot possibili
        let currentDate = new Date(startDate);
        
        while (currentDate < endDate) {
            if (isWorkingHours(currentDate)) {
                const slotEnd = new Date(currentDate.getTime() + SLOT_DURATION_MINUTES * 60000);
                
                // Verifica se lo slot è completamente libero
                const isSlotFree = !events.some(event => {
                    const eventStart = new Date(event.start.dateTime || event.start.date);
                    const eventEnd = new Date(event.end.dateTime || event.end.date);
                    
                    // C'è sovrapposizione?
                    return (currentDate < eventEnd && slotEnd > eventStart);
                });
                
                if (isSlotFree && slotEnd.getHours() <= WORKING_HOURS.end) {
                    availableSlots.push({
                        start: new Date(currentDate),
                        end: new Date(slotEnd),
                        date: currentDate.toLocaleDateString('it-IT'),
                        time: currentDate.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
                    });
                }
            }
            
            // Avanza di 120 minuti 
            currentDate = new Date(currentDate.getTime() + SLOT_DURATION_MINUTES * 60000);
        }
        
        return availableSlots;
    } catch (error) {
        console.error('Error fetching calendar:', error);
        throw error;
    }
}

/**
 * Trova il primo slot disponibile
 */
export async function findFirstAvailableSlot() {
    const now = new Date();
    const twoWeeksLater = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    
    const slots = await getAvailableSlots(now, twoWeeksLater);
    
    if (slots.length === 0) {
        return null;
    }
    
    return slots[0];
}

/**
 * Trova slot disponibili per una settimana specifica
 */
export async function findSlotsInWeek(weekOffset = 0) {
    const now = new Date();
    
    // Calcola lunedì della settimana target
    const currentDay = now.getDay();
    const daysToMonday = currentDay === 0 ? -6 : 1 - currentDay;
    const monday = new Date(now);
    monday.setDate(now.getDate() + daysToMonday + (weekOffset * 7));
    monday.setHours(0, 0, 0, 0);
    
    // Venerdì della stessa settimana
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    friday.setHours(23, 59, 59, 999);
    
    const slots = await getAvailableSlots(monday, friday);
    
    return {
        week: `${monday.toLocaleDateString('it-IT')} - ${friday.toLocaleDateString('it-IT')}`,
        slots: slots,
        morning: slots.filter(s => s.start.getHours() < WORKING_HOURS.lunchStart),
        afternoon: slots.filter(s => s.start.getHours() >= WORKING_HOURS.lunchEnd),
    };
}

/**
 * Trova il primo giorno con slot nel periodo specificato (mattina/pomeriggio)
 */
export async function findFirstDayWithSlot(period = 'any', weekOffset = 0) {
    const weekData = await findSlotsInWeek(weekOffset);
    
    let slotsToCheck = weekData.slots;
    if (period === 'morning') {
        slotsToCheck = weekData.morning;
    } else if (period === 'afternoon') {
        slotsToCheck = weekData.afternoon;
    }
    
    if (slotsToCheck.length === 0) {
        return null;
    }
    
    // Raggruppa per giorno
    const slotsByDay = {};
    slotsToCheck.forEach(slot => {
        const day = slot.date;
        if (!slotsByDay[day]) {
            slotsByDay[day] = [];
        }
        slotsByDay[day].push(slot);
    });
    
    const firstDay = Object.keys(slotsByDay)[0];
    return {
        date: firstDay,
        slots: slotsByDay[firstDay],
    };
}

/**
 * Crea un nuovo appuntamento
 */
export async function createAppointment(startDateTime, customerName, customerPhone, description) {
    const auth = await authorize();
    const calendar = google.calendar({ version: 'v3', auth });
    
    const endDateTime = new Date(startDateTime.getTime() + SLOT_DURATION_MINUTES * 60000);
    
    const event = {
        summary: `Intervento - ${customerName}`,
        description: `Cliente: ${customerName}\nTelefono: ${customerPhone}\nNote: ${description}`,
        start: {
            dateTime: startDateTime.toISOString(),
            timeZone: 'Europe/Rome',
        },
        end: {
            dateTime: endDateTime.toISOString(),
            timeZone: 'Europe/Rome',
        },
        reminders: {
            useDefault: false,
            overrides: [
                { method: 'email', minutes: 24 * 60 },
                { method: 'popup', minutes: 60 },
            ],
        },
    };
    
    try {
        const response = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            resource: event,
        });
        
        return {
            success: true,
            eventId: response.data.id,
            htmlLink: response.data.htmlLink,
            slot: {
                date: startDateTime.toLocaleDateString('it-IT'),
                time: startDateTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
            },
        };
    } catch (error) {
        console.error('Error creating event:', error);
        throw error;
    }
}

/**
 * Analizza richiesta in linguaggio naturale e restituisce slot disponibili
 */
export async function parseSchedulingRequest(userRequest) {
    const request = userRequest.toLowerCase();
    
    // "primo slot disponibile"
    if (request.includes('primo') && (request.includes('disponibile') || request.includes('libero'))) {
        const slot = await findFirstAvailableSlot();
        if (!slot) {
            return { type: 'no_slots', message: 'Non ci sono slot disponibili nelle prossime 2 settimane.' };
        }
        return { 
            type: 'first_available', 
            slot: slot,
            message: `Il primo slot disponibile è ${slot.date} alle ore ${slot.time}`,
        };
    }
    
    // "settimana prossima"
    let weekOffset = 0;
    if (request.includes('prossima settimana') || request.includes('settimana prossima')) {
        weekOffset = 1;
    } else if (request.includes('questa settimana')) {
        weekOffset = 0;
    }
    
    // "pomeriggio" o "mattina"
    let period = 'any';
    if (request.includes('pomeriggio')) {
        period = 'afternoon';
    } else if (request.includes('mattina') || request.includes('mattino')) {
        period = 'morning';
    }
    
    const dayData = await findFirstDayWithSlot(period, weekOffset);
    
    if (!dayData) {
        return { 
            type: 'no_slots', 
            message: `Non ci sono slot disponibili ${period === 'morning' ? 'la mattina' : period === 'afternoon' ? 'il pomeriggio' : ''} ${weekOffset === 1 ? 'la prossima settimana' : 'questa settimana'}.`,
        };
    }
    
    return {
        type: 'slots_found',
        date: dayData.date,
        slots: dayData.slots,
        message: `${weekOffset === 1 ? 'La prossima settimana' : 'Questa settimana'}, il primo giorno ${period === 'morning' ? 'con slot la mattina' : period === 'afternoon' ? 'con slot il pomeriggio' : 'disponibile'} è ${dayData.date}. Slot disponibili: ${dayData.slots.map(s => s.time).join(', ')}`,
    };
}
