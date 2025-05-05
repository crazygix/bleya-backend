export const authenticateUser = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = {
            uid: decodedToken.uid,
            phoneNumber: decodedToken.phone_number || '',
        };
        next();
    }
    catch (error) {
        console.error('Authentication error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
};
//# sourceMappingURL=auth.js.map