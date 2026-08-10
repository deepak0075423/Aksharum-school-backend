'use strict';
/**
 * Chat Module Seeder
 * Usage: node scripts/seedChat.js
 *
 * Creates sample chats between existing users to demonstrate the module.
 * Requires at least one school with teachers, students, and parents.
 */
require('dotenv').config();
const connectDB = require('../config/db');

const User              = require('../models/User');
const School            = require('../models/School');
const StudentProfile    = require('../models/StudentProfile');
const ParentProfile     = require('../models/ParentProfile');
const ClassSection      = require('../models/ClassSection');
const SectionSubjectTeacher = require('../models/SectionSubjectTeacher');
const Chat              = require('../models/Chat');
const ChatMember        = require('../models/ChatMember');
const Message           = require('../models/Message');

async function run() {
    await connectDB();
    console.log('🌱  Chat seeder started…\n');

    // ── 1. Ensure chat module is enabled for all schools ──────────────────────
    const updated = await School.updateMany({}, { $set: { 'modules.chat': true } });
    console.log(`✅  Enabled chat module for ${updated.modifiedCount} school(s)`);

    // ── 2. Pick a school to seed ──────────────────────────────────────────────
    const school = await School.findOne({ isActive: true }).lean();
    if (!school) { console.log('❌  No active school found. Exiting.'); process.exit(0); }
    console.log(`🏫  Seeding school: ${school.name} (${school._id})\n`);
    const sid = school._id;

    // ── 3. Find users ─────────────────────────────────────────────────────────
    const admin   = await User.findOne({ school: sid, role: 'school_admin', isActive: true }).lean();
    const teacher = await User.findOne({ school: sid, role: 'teacher',      isActive: true }).lean();
    const student = await User.findOne({ school: sid, role: 'student',      isActive: true }).lean();
    const parent  = await User.findOne({ school: sid, role: 'parent',       isActive: true }).lean();

    if (!admin || !teacher) {
        console.log('⚠️  Need at least one admin and one teacher. Exiting.');
        process.exit(0);
    }

    // ── 4. Make sure student is in a section that teacher is classTeacher of ──
    if (student) {
        const sp = await StudentProfile.findOne({ user: student._id, school: sid }).lean();
        if (sp && sp.currentSection) {
            await ClassSection.findByIdAndUpdate(sp.currentSection, {
                classTeacher: teacher._id,
            });
            console.log(`✅  Assigned ${teacher.name} as classTeacher for student's section`);
        }
    }

    // ── 5. Helper: create or reuse a direct chat ───────────────────────────────
    async function getOrCreateDirect(userA, userB) {
        const myM = await ChatMember.find({ user: userA._id, school: sid }).select('chat').lean();
        const ids = myM.map(m => m.chat);
        const existing = ids.length
            ? await ChatMember.findOne({ chat: { $in: ids }, user: userB._id }).lean()
            : null;
        if (existing) return existing.chat;

        const chat = await Chat.create({ school: sid, type: 'direct', createdBy: userA._id });
        await ChatMember.insertMany([
            { chat: chat._id, user: userA._id, school: sid, role: 'admin' },
            { chat: chat._id, user: userB._id, school: sid, role: 'member' },
        ]);
        return chat._id;
    }

    // ── 6. Teacher ↔ Admin direct chat ────────────────────────────────────────
    const chatTA = await getOrCreateDirect(admin, teacher);
    await seedMessages(chatTA, sid, [
        { sender: admin,   content: 'Hello! How are things going in the classroom?' },
        { sender: teacher, content: 'Going great! Students are engaged with the new curriculum.' },
        { sender: admin,   content: 'Wonderful. Let me know if you need any resources.' },
    ]);
    console.log('✅  Admin ↔ Teacher direct chat seeded');

    // ── 7. Teacher ↔ Student direct chat ─────────────────────────────────────
    if (student) {
        const chatTS = await getOrCreateDirect(teacher, student);
        await seedMessages(chatTS, sid, [
            { sender: teacher, content: 'Hi! I wanted to check on your assignment progress.' },
            { sender: student, content: 'I have submitted it yesterday, sir.' },
            { sender: teacher, content: 'Great work! You scored very well.' },
        ]);
        console.log('✅  Teacher ↔ Student direct chat seeded');
    }

    // ── 8. Teacher ↔ Parent direct chat ──────────────────────────────────────
    if (parent) {
        // Link parent to student if not already
        if (student) {
            await ParentProfile.findOneAndUpdate(
                { user: parent._id, school: sid },
                { $addToSet: { children: student._id } }
            );
        }
        const chatTP = await getOrCreateDirect(teacher, parent);
        await seedMessages(chatTP, sid, [
            { sender: teacher, content: 'Good evening! Your child has been doing excellent work.' },
            { sender: parent,  content: 'Thank you for the update, teacher!' },
        ]);
        console.log('✅  Teacher ↔ Parent direct chat seeded');
    }

    // ── 9. Class group chat ───────────────────────────────────────────────────
    const classGroupMembers = [admin._id, teacher._id];
    if (student) classGroupMembers.push(student._id);
    if (parent)  classGroupMembers.push(parent._id);

    let classGroup = await Chat.findOne({ school: sid, type: 'group', name: 'Class Announcements' }).lean();
    if (!classGroup) {
        classGroup = await Chat.create({
            school: sid, type: 'group',
            name: 'Class Announcements',
            description: 'Official class announcements and updates',
            createdBy: teacher._id,
            isReadOnly: true,
        });
        await ChatMember.insertMany(classGroupMembers.map(uid => ({
            chat: classGroup._id, user: uid, school: sid,
            role: String(uid) === String(teacher._id) ? 'admin' : 'member',
        })));
        await seedMessages(classGroup._id, sid, [
            { sender: teacher, content: '📢 Welcome to the Class Announcements channel! I will post important updates here.' },
            { sender: teacher, content: '📅 Reminder: Parent-Teacher meeting is on Friday at 4 PM.' },
            { sender: admin,   content: '✅ Great initiative! Keep all parents and students informed.' },
        ]);
        console.log('✅  Class Announcements group seeded');
    }

    // ── 10. Teacher group ─────────────────────────────────────────────────────
    const extraTeachers = await User.find({ school: sid, role: 'teacher', isActive: true, _id: { $ne: teacher._id } })
        .limit(3).lean();
    const teacherGroupMembers = [teacher._id, ...extraTeachers.map(t => t._id)];

    let teacherGroup = await Chat.findOne({ school: sid, type: 'group', name: "Staff Room" }).lean();
    if (!teacherGroup && teacherGroupMembers.length >= 1) {
        teacherGroup = await Chat.create({
            school: sid, type: 'group',
            name: 'Staff Room',
            description: 'Private teacher coordination channel',
            createdBy: teacher._id,
        });
        await ChatMember.insertMany(teacherGroupMembers.map(uid => ({
            chat: teacherGroup._id, user: uid, school: sid,
            role: String(uid) === String(teacher._id) ? 'admin' : 'member',
        })));
        await seedMessages(teacherGroup._id, sid, [
            { sender: teacher, content: 'Team — please check the updated exam schedule in the portal.' },
            { sender: teacher, content: 'Also, the practical lab is booked for Thursday afternoon.' },
        ]);
        console.log('✅  Staff Room group seeded');
    }

    console.log('\n🎉  Chat seeder complete! Open /chat to explore the module.');
    process.exit(0);
}

async function seedMessages(chatId, schoolId, items) {
    const count = await Message.countDocuments({ chat: chatId });
    if (count > 0) return; // Already seeded

    for (const item of items) {
        await Message.create({
            chat:       chatId,
            school:     schoolId,
            sender:     item.sender._id,
            senderRole: item.sender.role,
            content:    item.content,
            type:       'text',
        });
    }
    const lastMsg = await Message.findOne({ chat: chatId }).sort({ createdAt: -1 }).lean();
    if (lastMsg) {
        await Chat.findByIdAndUpdate(chatId, {
            lastMessage: lastMsg._id, lastActivity: lastMsg.createdAt,
        });
    }
}

run().catch(err => { console.error(err); process.exit(1); });
